var FramingBuffer = require('framing-buffer'),
    OffsetBuffer = require('offset-buffer'),
    debug = false,
    net = require('net'),
    events = require('events'),
    util = require('util'),
    when = require('when'),
    errors = require('./errors.js')(util);

module.exports = require('./framing-socket.js')(
    FramingBuffer,
    OffsetBuffer,
    debug,
    net,
    events,
    util,
    when,
    errors,
    console
);