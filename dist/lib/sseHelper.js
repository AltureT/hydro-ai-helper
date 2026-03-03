"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSSEWriter = createSSEWriter;
function createSSEWriter(res) {
    let isClosed = false;
    res.on('close', () => { isClosed = true; });
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    return {
        writeEvent(event, data) {
            if (isClosed)
                return;
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            res.write(`event: ${event}\ndata: ${json}\n\n`);
        },
        writeComment(comment) {
            if (isClosed)
                return;
            res.write(`: ${comment}\n\n`);
        },
        end() {
            if (isClosed)
                return;
            isClosed = true;
            res.end();
        },
        get closed() {
            return isClosed;
        },
    };
}
//# sourceMappingURL=sseHelper.js.map