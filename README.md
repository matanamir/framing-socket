# framing-socket

[![Build Status](https://travis-ci.org/matanamir/framing-socket.png)](https://travis-ci.org/matanamir/framing-socket)

FramingSocket adds variable size framing and simple promise-based request/response notifications to normal sockets.

Note that the FramingSocket assumes a request/response protocol of some form where the first frame bytes are the
size of the frame, and each frame response contains an RPC ID to associate it with the sent request.

The user can define their own frame_length reader function and rpc_id reader function to find and parse those
values from the frame.

It also includes a simplistic backpressure mechanism based on the number of "falsey" write()s and will emit the
common pause/resume events based on this upstream.

**Note**: *Still experimental. Use with caution*

## Example

```js
var FramingSocket = require('framing-socket');

var options = {
    frame_length_size: 4,                           // frame_length field size in bytes
    frame_length_reader: function(offset_buffer) {  // custom function to read the frame_length
      return offset_buffer.readInt32BE();           // note that it passes in an OffsetBuffer (see 'offset-buffer' repo)
    }
    rpc_id_reader: function(offset_buffer) {        // custom function to read the rpc_id from the buffer
      return offset_buffer.readInt32BE();           // The frame_length field is stripped from this OffsetBuffer already
    }
};

var socket = new FramingSocket(options);
var rpc_id = 123;                                   // Unique RPC ID to identify this request (unique to this connection)

socket.write(rpc_id, new Buffer([0x01, 0x02, 0x03])).
    then(function on_success(frame) {
        // do something with the returned frame (minus the frame_length bytes)
    });
```

## Install

```
npm install framing-socket
```

## Tests

```
npm test
```

## License

MIT License
