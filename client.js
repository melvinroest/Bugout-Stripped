var Bugout = require("./bugout.no.rpc.no.encryption");

var swarmId = undefined; //type in your own swarmId for it to work
var b = new Bugout(swarmId);

// It's always nice to inspect what's there
console.log(b);

b.on("message", function(address, msg) {
  var p = document.createElement("p");
  p.innerHTML = `address ${address}: sends message ${msg}`;
  document.getElementById("content").append(p);
});

// wait for peer list -- yes, with a setTimeout. No I will not apologize ;-)
setTimeout(function() {
  b.send("Hello World!");
}, 3000);
