var TestSocketServer = require('test-socket-server'),
    server = new TestSocketServer({
        find_free_port: true
    }),
    port = parseInt(process.argv[2], 10) || 8118;

server.listen(port);



