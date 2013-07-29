var events = require('events'),
    util = require('util');

function LoopbackNet() {}
LoopbackNet.prototype.connect = function(options, callback) {
    process.nextTick(function() {
        callback();
    });
    return new LoopbackSocket(options);
};

function LoopbackSocket(options) {
    events.EventEmitter.call(this);
    this.remoteAddress = options.host;
    this.remotePort = options.port;
    this.bufferSize = 0;
}
util.inherits(LoopbackSocket, events.EventEmitter);
LoopbackSocket.prototype.setKeepAlive = function() {};
LoopbackSocket.prototype.setNoDelay = function() {};
LoopbackSocket.prototype.setTimeout = function() {};
LoopbackSocket.prototype.end = function() {};
LoopbackSocket.prototype.write = function(data) {
    var self = this;

    process.nextTick(function() {
        self.emit('data', data);
    });
    return true;
};

module.exports = new LoopbackNet();
