module.exports = Bugout;

var debug = console.log;
var WebTorrent = require("webtorrent");
var bencode = require("bencode");
var nacl = require("tweetnacl");
var EventEmitter = require("events").EventEmitter;
var inherits = require("inherits");
var bs58 = require("bs58");
var bs58check = require("bs58check");
var ripemd160 = require("ripemd160");

inherits(Bugout, EventEmitter);

var EXT = "bo_channel";
var PEERTIMEOUT = 5 * 60 * 1000;
var SEEDPREFIX = "490a";
var ADDRESSPREFIX = "55";

/**
 * Multi-party data channels on WebTorrent extension.
 */
function Bugout(identifier, opts) {
  if (identifier && typeof identifier == "object") {
    opts = identifier;
    identifier = null;
  }
  var opts = opts || {};
  if (!(this instanceof Bugout)) return new Bugout(identifier, opts);

  var trackeropts = opts.tracker || {};
  trackeropts.getAnnounceOpts =
    trackeropts.getAnnounceOpts ||
    function() {
      return { numwant: 4 };
    };
  if (opts.iceServers) {
    trackeropts.rtcConfig = { iceServers: opts.iceServers };
  }
  this.announce = opts.announce || [
    "wss://hub.bugout.link",
    "wss://tracker.openwebtorrent.com"
  ];
  this.wt = opts.wt || new WebTorrent({ tracker: trackeropts });
  this.nacl = nacl;

  if (opts["seed"]) {
    this.seed = opts["seed"];
  } else {
    //random seed
    this.seed = this.encodeseed(nacl.randomBytes(32));
  }

  this.timeout = opts["timeout"] || PEERTIMEOUT; //5 minutes
  this.keyPair =
    opts["keyPair"] ||
    nacl.sign.keyPair.fromSeed(
      Uint8Array.from(bs58check.decode(this.seed)).slice(2)
    );

  this.pk = bs58.encode(Buffer.from(this.keyPair.publicKey));

  this.identifier = identifier || this.address();
  this.peers = {}; // list of peers seen recently: address -> pk, timestamp
  this.seen = {}; // messages we've seen recently: hash -> timestamp
  this.lastwirecount = null;

  // pending callback functions
  this.callbacks = {};
  this.serveraddress = null;
  this.heartbeattimer = null;

  debug("address", this.address());
  debug("identifier", this.identifier);
  debug("public key", this.pk);

  if (typeof File == "object") {
    var blob = new File([this.identifier], this.identifier);
  } else {
    var blob = new Buffer.from(this.identifier);
    blob.name = this.identifier;
  }

  //seeding the webtorrent is where the magic happens
  var torrent = this.wt.seed(
    blob,
    { name: this.identifier, announce: this.announce },
    //function onseed(torrent)
    partial(function(bugout, torrent) {
      // debug("torrent", bugout.identifier, torrent);
      debug("torrent", "torrent.name", torrent.name);
      debug(
        "torrent.infoHash",
        torrent.infoHash,
        "torrent.magnetURI",
        torrent.magnetURI
      );
      bugout.emit("torrent", bugout.identifier, torrent);
      //using torrent discovery API
      if (torrent.discovery.tracker) {
        torrent.discovery.tracker.on("update", function(update) {
          bugout.emit("tracker", bugout.identifier, update);
        });
      }
      torrent.discovery.on("trackerAnnounce", function() {
        bugout.emit("announce", bugout);
        bugout.connections();
      });
    }, this)
  );
  // Emitted whenever a new peer is connected for this torrent.
  torrent.on("wire", partial(attach, this, this.identifier));
  console.log("connected to peer with identifier " + this.identifier);
  this.torrent = torrent;

  if (opts.heartbeat) {
    this.heartbeat(opts.heartbeat);
  }
}

Bugout.prototype.WebTorrent = WebTorrent;

//I wonder why he is encoding the seed, I don't think it was needed
Bugout.encodeseed = Bugout.prototype.encodeseed = function(material) {
  return bs58check.encode(
    Buffer.concat([Buffer.from(SEEDPREFIX, "hex"), Buffer.from(material)])
  );
};

//I also don't understand why he is encoding the heartbeat
Bugout.encodeaddress = Bugout.prototype.encodeaddress = function(material) {
  return bs58check.encode(
    Buffer.concat([
      Buffer.from(ADDRESSPREFIX, "hex"),
      new ripemd160().update(Buffer.from(nacl.hash(material))).digest()
    ])
  );
};

// smart way of removing old peers
// start a heartbeat and expire old "seen" peers who don't send us a heartbeat
Bugout.prototype.heartbeat = function(interval) {
  var interval = interval || 30000;
  this.heartbeattimer = setInterval(
    partial(function(bugout) {
      // broadcast a 'ping' message
      bugout.ping();
      var t = now();
      // remove any 'peers' entries with timestamps older than timeout
      for (var p in bugout.peers) {
        var pk = bugout.peers[p].pk;
        var address = bugout.address(pk);
        var last = bugout.peers[p].last;
        if (last + bugout.timeout < t) {
          delete bugout.peers[p];
          bugout.emit("timeout", address);
          bugout.emit("left", address);
        }
      }
    }, this),
    interval
  );
};

// cleaning up means removing the torrent
// clean up this bugout instance
Bugout.prototype.destroy = function(cb) {
  clearInterval(this.heartbeattimer);
  var packet = makePacket(this, { y: "x" });
  sendRaw(this, packet);
  this.wt.remove(this.torrent, cb);
};

Bugout.prototype.close = Bugout.prototype.destroy;

Bugout.prototype.connections = function() {
  if (this.torrent.wires.length != this.lastwirecount) {
    this.lastwirecount = this.torrent.wires.length;
    this.emit("connections", this.torrent.wires.length);
  }
  return this.lastwirecount;
};

// This is where this.address() goes
// So it encodes your public key, which is also your address?
Bugout.prototype.address = function(pk) {
  if (pk && typeof pk == "string") {
    pk = bs58.decode(pk);
  } else if (pk && pk.length == 32) {
    pk = pk;
  } else {
    pk = this.keyPair.publicKey;
  }
  return this.encodeaddress(pk);
};

Bugout.address = Bugout.prototype.address;

Bugout.prototype.ping = function() {
  // send a ping out so they know about us too
  var packet = makePacket(this, { y: "p" });
  sendRaw(this, packet);
};

Bugout.prototype.send = function(address, message) {
  if (!message) {
    var message = address;
    var address = null;
  }
  var packet = makePacket(this, { y: "m", v: JSON.stringify(message) });
  sendRaw(this, packet);
};

// outgoing

function makePacket(bugout, params) {
  var p = {
    t: now(),
    i: bugout.identifier,
    pk: bugout.pk,
    n: nacl.randomBytes(8)
  };
  for (var k in params) {
    p[k] = params[k];
  }
  pe = bencode.encode(p);
  return bencode.encode({
    s: nacl.sign.detached(pe, bugout.keyPair.secretKey),
    p: pe
  });
}

//So you need to send a message over the wires?
//*And* use the extension that he made, called bo_channel?
function sendRaw(bugout, message) {
  var wires = bugout.torrent.wires;
  //for each wire
  for (var w = 0; w < wires.length; w++) {
    //get the key "peerExtendedHankshake"
    var extendedhandshake = wires[w]["peerExtendedHandshake"];
    if (extendedhandshake && extendedhandshake.m && extendedhandshake.m[EXT]) {
      //This is where the magic happens
      //See github.com/webtorrent/bittorrent-protocol and http://www.bittorrent.org/beps/bep_0010.html
      //The explanation is a bit confusing though
      wires[w].extended(EXT, message);
    }
  }
  var hash = toHex(nacl.hash(message).slice(16)); //pure debug value
  debug("sent", hash, "to", wires.length, "wires"); //for this log
}

// incoming -- this is where message unpacking happens and where you can see his message packing scheme the best
// message types: (m)essage, (r)pc, (r)pc (r)esponse, (p)ing, (x)rossed out/leave/split/kruisje
function onMessage(bugout, identifier, wire, message) {
  // hash to reference incoming message
  var hash = toHex(nacl.hash(message).slice(16));
  var t = now();
  debug("raw message", identifier, message.length, hash);
  if (!bugout.seen[hash]) {
    var unpacked = bencode.decode(message); //he needs to decode bencode, because that is how the bittorrent protocol communicates, I think...
    if (unpacked && unpacked.p) {
      debug(
        "unpacked message"
        // unpacked
      );
      var packet = bencode.decode(unpacked.p);
      var pk = packet.pk.toString();
      var id = packet.i.toString();
      var checksig = nacl.sign.detached.verify(
        unpacked.p,
        unpacked.s,
        bs58.decode(pk)
      );
      var checkid = id == identifier;
      var checktime = packet.t + bugout.timeout > t;
      debug(
        "packet"
        // packet
      );
      if (checksig && checkid && checktime) {
        //note that this means the sender is pinged back
        sawPeer(bugout, pk, identifier);
        // check packet types
        // m stands for message
        if (packet.y == "m") {
          debug(
            "message",
            identifier
            // packet
          );
          var messagestring = packet.v.toString();
          var messagejson = null;
          try {
            var messagejson = JSON.parse(messagestring);
          } catch (e) {
            debug("Malformed message JSON: " + messagestring);
          }
          if (messagejson) {
            bugout.emit("message", bugout.address(pk), messagejson, packet);
          }
        }
        // p stands for ping
        else if (packet.y == "p") {
          var address = bugout.address(pk);
          debug("ping from", address);
          bugout.emit("ping", address);
        }
        // x stands for split/leave
        else if (packet.y == "x") {
          var address = bugout.address(pk);
          debug("got left from", address);
          delete bugout.peers[address];
          bugout.emit("left", address);
        } else {
          // TODO: handle ping/keep-alive message
          debug("unknown packet type");
        }
      } else {
        debug("dropping bad packet", hash, checksig, checkid, checktime);
      }
    } else {
      debug("skipping packet with no payload", hash, unpacked);
    }
    // forward first-seen message to all connected wires
    // TODO: block flooders
    sendRaw(bugout, message);
  } else {
    debug("already seen", hash);
  }
  // refresh last-seen timestamp on this message
  bugout.seen[hash] = now();
}

// network functions

function sawPeer(bugout, pk, identifier) {
  debug("sawPeer", bugout.address(pk));
  var t = now();
  var address = bugout.address(pk);
  // ignore ourself
  if (address != bugout.address()) {
    // if we haven't seen this peer for a while
    if (
      !bugout.peers[address] ||
      bugout.peers[address].last + bugout.timeout < t
    ) {
      bugout.peers[address] = {
        pk: pk,
        last: t
      };
      debug("seen", bugout.address(pk));
      bugout.emit("seen", bugout.address(pk));
      if (bugout.address(pk) == bugout.identifier) {
        bugout.serveraddress = address;
        debug("seen server", bugout.address(pk));
        bugout.emit("server", bugout.address(pk));
      }
      // send a ping out so they know about us too
      var packet = makePacket(bugout, { y: "p" });
      sendRaw(bugout, packet);
    } else {
      bugout.peers[address].last = t;
    }
  }
}

// extension protocol plumbing
// see also https://github.com/webtorrent/ut_metadata/blob/master/index.js for another example

function attach(bugout, identifier, wire, addr) {
  debug("saw wire", wire.peerId, addr);
  wire.use(extension(bugout, identifier, wire));
  wire.on("close", partial(detach, bugout, identifier, wire));
}

function detach(bugout, identifier, wire) {
  debug("wire left", wire.peerId, identifier);
  bugout.emit("wireleft", bugout.torrent.wires.length, wire);
  bugout.connections();
}

// I need to debug this pure magic -- Melvin
function extension(bugout, identifier, wire) {
  var ext = partial(wirefn, bugout, identifier);
  ext.prototype.name = EXT;
  ext.prototype.onExtendedHandshake = partial(
    onExtendedHandshake,
    bugout,
    identifier,
    wire
  );
  ext.prototype.onMessage = partial(onMessage, bugout, identifier, wire);
  return ext;
}

function wirefn(bugout, identifier, wire) {
  // TODO: sign handshake to prove key custody
  wire.extendedHandshake.id = identifier;
  wire.extendedHandshake.pk = bugout.pk;
}

function onExtendedHandshake(bugout, identifier, wire, handshake) {
  debug(
    "wire extended handshake",
    bugout.address(handshake.pk.toString()),
    wire.peerId
    // handshake
  );
  bugout.emit("wireseen", bugout.torrent.wires.length, wire);
  bugout.connections();
  // TODO: check sig ðfnd drop on failure - wire.peerExtendedHandshake
  sawPeer(bugout, handshake.pk.toString(), identifier);
}

// utility fns

function now() {
  return new Date().getTime();
}

// https://stackoverflow.com/a/39225475/2131094
function toHex(x) {
  return x.reduce(function(memo, i) {
    return memo + ("0" + i.toString(16)).slice(-2);
  }, "");
}

// javascript why
function partial(fn) {
  var slice = Array.prototype.slice;
  var stored_args = slice.call(arguments, 1);
  return function() {
    var new_args = slice.call(arguments);
    var args = stored_args.concat(new_args);
    return fn.apply(null, args);
  };
}
