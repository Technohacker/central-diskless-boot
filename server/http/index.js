const restana = require('restana');
const dedent = require('dedent');
const serveStatic = require('serve-static');

/// Config

const USER_MAP = {
    // Add users as `"MAC_ADDR": "USER"` pairs
};
const PORT = 3000;

/// Actual service

function log(message) {
    console.log(`[${new Date().toLocaleString()}] ${message}`);
}

const service = restana();

service.get('/:mac_addr/boot.ipxe', (req, res) => {
    const user = USER_MAP[req.params.mac_addr];

    if (user) {
        log(`Boot requested from user: ${user}`);
        res.send(dedent(`
            #!ipxe
            kernel /boot/vmlinuz initrd=initrd.img overlayroot=tmpfs:recurse=0 systemd.setenv=DISKLESS_HOME_NAME=${user} quiet splash vt.handoff=7
            initrd /boot/initrd.img
            boot
        `));
    } else {
        log(`No user found for MAC Address: ${req.params.mac_addr}`);
        res.send(404);
    }
});

service.use(async (req, res, next) => {
    await next();
    log(`[${new Date().toLocaleString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${res.statusMessage}`);
});
service.use("/boot", serveStatic("/srv/client_root"));

service.start(PORT);
log(`Running on port ${PORT}`);
