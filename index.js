var FramingBuffer = require('framing-buffer'),
    OffsetBuffer = require('offset-buffer'),
    debug = false,
    net = require('net'),
    metrics = require('metrics'),
    events = require('events'),
    util = require('util'),
    errors = require('./errors.js')(util);

module.exports = require('./framing-socket.js')(
    FramingBuffer,
    OffsetBuffer,
    debug,
    metrics,
    net,
    events,
    util,
    errors,
    console
);