import * as net from 'net';

export function WaitForPortToOpen(port: number, timeout: number): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        var timedOut = false;
        const handle = setTimeout(() => {
            timedOut = true;
            reject(`Timeout after ${timeout} milli-seconds`);
        }, timeout);

        tryToConnect();

        function tryToConnect() {
            if (timedOut) {
                return;
            }

            var socket = net.connect({ port: port }, () => {
                if (timedOut) {
                    return;
                }

                socket.end();
                clearTimeout(handle);
                resolve();
            });
            socket.on("error", error => {
                if (timedOut) {
                    return;
                }

                if ((<any>error).code === "ECONNREFUSED" && !timedOut) {
                    setTimeout(() => { tryToConnect(); }, 10);
                    return;
                }

                clearTimeout(handle);
                if (error && error.message) {
                    error.message = `connection failed (${error.message})`;
                }
                reject(error);
            });
        }
    });
}