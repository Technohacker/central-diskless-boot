const restana = require('restana');
const dedent = require('dedent');
const serveStatic = require('serve-static');

/// Config

const USER_MAP = {
    
};


/// Actual service

const service = restana();

service.get('/:mac_addr/boot.ipxe', (req, res) => {
    const user = USER_MAP[req.params.mac_addr];

    if (user) {
        res.send(dedent(`
            #!ipxe
            kernel /boot/vmlinuz initrd=initrd.img overlayroot=tmpfs:recurse=0 systemd.setenv=DISKLESS_HOME_NAME=${user} quiet splash vt.handoff=7
            initrd /boot/initrd.img
            boot
        `));
    } else {
        res.send("", 404);
    }
});
service.use("/boot", serveStatic("/srv/client_root/boot"));

service.start(3000);