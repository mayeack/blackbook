/**
 * Test-only HTTP setup (vitest setupFiles: runs in every test worker before its test file).
 *
 * supertest's request(app) starts a throwaway server per request with listen(0), which listens on every interface
 * ("::"), and then sends the request to 127.0.0.1:<port>. macOS hands out ephemeral ports in sequence, and other apps
 * listen on ports in that range over IPv4 (rekordbox on *:50000/55000/55002, Duo Desktop on 127.0.0.1:53100/53106).
 * A throwaway server given one of those ports never sees its request: the kernel delivers the IPv4 connection to the
 * other app's listener, so the test times out, fails with "socket hang up", or gets that app's 404. Which test fails
 * depends on where the port counter is (a full run moves it ~900), so it was a different one each time.
 * On 127.0.0.1 the throwaway server is the most specific listener on its port, and the kernel never gives it a port
 * another app holds on 127.0.0.1.
 */
import http from 'node:http';

// listen(0, '127.0.0.1') would bind a tick later (Node looks the host up first), but supertest reads
// server.address() straight after listen(0). Without a host, listen() binds at once through _listen2, which net.js
// keeps under that name for code that wraps it: there, "no host" becomes 127.0.0.1 instead of "::" / "0.0.0.0".
type Listen2 = (this: http.Server, address: string | null, port: number, addressType: number, ...rest: unknown[]) => void;
const proto = http.Server.prototype as unknown as { _listen2: Listen2 };
const listen2 = proto._listen2;
proto._listen2 = function (address, port, addressType, ...rest) {
  return address == null && port === 0
    ? listen2.call(this, '127.0.0.1', 0, 4, ...rest)
    : listen2.call(this, address, port, addressType, ...rest);
};

// No keep-alive: each request gets its own connection, closed by the server right after its response, so nothing
// outlives the throwaway server it was made for (Node's global agent keeps sockets alive since Node 19).
http.globalAgent = new http.Agent({ keepAlive: false });
