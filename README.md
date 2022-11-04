# Central Diskless Boot

This repository contains my experiments and instructions on setting up fully diskless Linux VMs that make use of a central server for their boot-up and file storage

Note: This setup was built for use in a virtualization environment where each VM runs on the same machine and can make use of on-host routing for faster network transfers. However, if your physical LAN is fast enough, this setup should still provide acceptable performance for physical machines connecting to a LAN server

For a quick summary, each VM in this setup uses iPXE with HTTP for loading the kernel image rather than PXE with TFTP. The iPXE boot image used is embedded with a script that delegates to a script loaded over HTTP. The HTTP server identifies the client making the request and provides the kernel and initramfs, along with client-specific kernel boot parameters

### Reasons
I maintain VMs used for dev environments on a Proxmox VE host, where each VM has essentially the same OS and software installed. Previously each VM maintained their own virtual HDD, containing the root FS and all user files. Keeping each system up to date manually would have been a chore, and backups of all systems would unnecessarily include their root FS too

Tools do exist for easing some of these issues (for example Ansible, to run a sequence of actions on multiple machines at once), however that would continue to necessitate a base image, with the continued risk of diverging system images

### Goals
1. Require no virtual disks allocated to each VM which cannot be shared
2. Avoid putting significant memory overhead on each VM (ex. by having the system image in a tmpfs root)
3. Maintain a single location for the common system image and individual home directories
4. Require very little configuration on each individual VM
5. Don't require any special configuration from the network the VM host is connected to
6. Stick to using packages provided by each distro, which helps maintainability

### Environment
In this setup I use Proxmox VE 7 as my virtualization host, and each client VM will be running Ubuntu 22.04. I've used Fedora 34 Server Edition for running all server-side components of this project. However, these instructions should still be usable for alternatives

## Preparing the central server FS
Since each client VM will make use of the central server for their root FS, we need a networked file system that's natively supported by the kernel. Linux provides an in-kernel NFS client, and NFS maintains POSIX permissions (except ACLs), which fit the bill perfectly

Linux also provides an NFS server module, but making use of it in LXC (for running it in a container) was unwieldy and I didn't want to install anything on Proxmox itself, meaning the netboot server had to run in a VM. It's likely possible to run a userspace NFS server (like NFS-Ganesha) instead, however I couldn't get it working reliably

At this point, the server exports the following path, with `exportfs -arv` used for re-exporting in case of changes:
```sh
# Client Root FS
/srv/client_root    IP-RANGE/CIDR(ro,no_root_squash)
# ...
```

## Creating the (initial) Client Root FS
I opted to prepare an install of Ubuntu onto a virtual HDD using the official LiveCD. An alternative was to use `debootstrap` directly on the server NFS export to prepare an Ubuntu root FS from scratch, however that was finicky to perform. Once the basic install was done (while choosing LVM for easier labels and resizes), I moved the disk over to the Server VM and added the following fstab entry:

```fstab
/dev/mapper/vgubuntu-root   /srv/client_root    ext4    defaults    0 0
```

This has the added advantage of not burdening the Server's root FS. A similar mount could be made for the home directories too

A pleasant surprise from Ubuntu was ready-made support for NFS root FS in its `initramfs-tools`. [A guide](https://help.ubuntu.com/community/DisklessUbuntuHowto) from Ubuntu's community help pages provided the following steps:

1. Chroot into the Ubuntu rootfs on the Server (I've provided a simple script for this under `server/chroot/client-root-chroot` which will be useful for future maintenance)
    ```sh
    for dir in sys dev proc; do mount --rbind /$dir /srv/client_root/$dir && mount --make-rslave /srv/client_root/$dir; done
    chroot /srv/client_root
    ```
1. Open `/etc/initramfs-tools/initramfs.conf` on the
2. Set `MODULES=netboot` to prepare a netboot-capable initramfs
3. Set `BOOT=nfs` to enable NFS boot
4. Set `NFSROOT=<ip address of server>:/srv/client_root` since we cannot adjust the DHCP server
5. Run `update-initramfs -uk all` to regenerate `/boot/initrd.img`

The client root FS needed updates to make sure it would not attempt to mount the non-existant boot disk on each Client VM, so I removed entries for the root FS and swap partition from the client's `/etc/fstab`

## Booting a diskless VM
Since we cannot make use of client VM disks, we cannot keep a bootloader there. Net-booting via PXE is an option, but since it requires the use of a custom DHCP config/server, I deemed it was unusable for our purposes. For situations where they are feasible, they can be used instead

Instead, I came across the iPXE project, which:
1. Can be booted from an ISO (CD images can be shared across VMs in Proxmox)
2. Implements UEFI HTTP boot, and can load and execute scripts from an HTTP server
3. Can have an embedded script that runs on boot

iPXE can also be built to support HTTPS, adding a layer of security to the boot process

I prepared the following embedded script in a custom iPXE ISO (this is handled automatically with the Makefile in this repository):
```sh
#!ipxe

# Get an IP address from DHCP
dhcp
# Continue executing a script loaded from the boot server
chain http://server-ip:port/${net0/mac}/boot.ipxe
```

iPXE is capable of passing the MAC address of the VM when requesting the chain script, which the server can to send user-specific boot parameters. The returned script is as follows:

```sh
#!ipxe

# Load the kernel image
kernel /boot/vmlinuz initrd=initrd.img
# Load the init ramdisk
initrd /boot/initrd.img
# Boot into the kernel
boot
```

Any HTTP server is usable, static or dynamic, depending on your requirements, though this repo provides a basic NodeJS-based server that also supplies user-specific boot parameters. This gets the VM started into loading Ubuntu, but fails before loading the desktop due to a lack of write access to the root FS

## Fixing boot-up
One option was to add fstab entries to the client FS that mounted tmpfs to certain folders under /var, but this was too fragile. However, there is a convenient package in Ubuntu's package repos called `overlayroot`. This prepares a script in initramfs that:

1. Moves the currently mounted root FS (in our case, provided via NFS) into `/media/root-ro`
2. Mounts a `tmpfs` on `/media/root-rw`
3. Mounts `overlayfs` on `/` with `/media/root-ro` as the base and `/media/root-rw` as the upper-layer

As a bonus, it can be configured from the kernel command-line. This provides a writeable overlay over a read-only base, allowing the rest of the system to boot normally. No changes are persisted across reboots however, due to the use of `tmpfs`. This was a reasonable trade-off since the user's home directory will be persisted later

To set it up:
1. Enter the Ubuntu root FS on the Server using `chroot` as mentioned before
2. Edit `/etc/resolv.conf` to add `nameserver 1.1.1.1` for DNS resolution. The above path is actually a symlink to a runtime-generated file, and when the system is booted, it will not use the created file here
3. Run `apt install overlayroot`
4. Add `overlayroot=tmpfs:recurse=0` to the kernel parameters provided by the HTTP boot server. `recurse=0` ensures any further mounts (like for /home) made by us will be read-write

This allows boot-up to proceed. `systemd` also prepares tmpfs mounts for us on certain folders later

## Persisting the user's home directory
Since all VMs get the same root FS, they will also get the same home directory mounted to all of them if specified in `/etc/fstab`. This is useful for certain cases (ex. a common admin account), and can be set up by adding the following line to the client fstab:

```fstab
<server-ip>:/srv/client-homes/<user>    /home/<user>    nfs defaults    0 0
```

For parameterized mounts however, a different approach is needed. Alongside defining `systemd` services, you can also define `.mount` units, which can mount a disk on boot-up in conjunction to fstab (systemd auto-generates .mount units from fstab on boot to provide a consistent system)

1. First edit the kernel command-line in the HTTP boot server to add `systemd.setenv=DISKLESS_HOME_NAME=<user based on MAC address>`. This tells systemd to add the provided environment variable to systemd's environment, and allows our mount unit to remain the same with per-VM changes
2. Enter the Ubuntu chroot
3. Create `/etc/systemd/system/home-user.mount` with the following contents:
    ```ini
    [Unit]
    Description=Load home directory from NFS
    # Wait for the NFS client to be ready
    After=nfs-client.target
    # Make sure the system waits for this mount to be ready before allowing other users
    WantedBy=multi-user.target

    [Mount]
    What=<server-ip>:/srv/client_homes/$(DISKLESS_HOME_NAME)
    Where=/home/user
    Type=nfs
    Options=defaults
    ```
    This restricts the changing home directory to have the same path `/home/user` on all VMs. As per systemd requirements, the filename for this mount unit must stay consistent with the mount path (`home-user` for `/home/user`)
4. Run `cd /etc/systemd/system/multi-user.wants && ln -s /etc/systemd/system/home-user.mount`. This will ensure the NFS export is mounted on boot, and is done manually because `systemctl enable home-user.mount` does not work inside chroot
5. Create an NFS export for each home directory under `/srv/client_homes/<user>`, and ensure your HTTP server provides the correct user name for each Client VM MAC address

Rebooting the client VM should now provide a persistent home directory. This same procedure can be used to mount other such directories on a per-user basis

## Fixing client DNS resolution
At this point, the client VM is fully booted and persisted, but network access is limited, and DNS queries fail to work

This occurs because:
1. On boot, the kernel obtains an IP address using DHCP automatically. This is needed for the in-kernel NFS client to connect to the server
2. `systemd-networkd`, in charge of initializing network devices in userspace, sees that the network adapter has an existing IP address and does not make any alterations
3. `systemd-resolved`, in charge of DNS query resolution, asks the network manager for upstream DNS servers that it should make requests to
4. `NetworkManager` sees the existing IP address on the network adapter, and switches to connection mode Manual to preserve it. However, in this state it fails to set any DNS servers since DHCP no longer provides it

To fix this, I create the following file at `/etc/systemd/resolved.conf.d/dns.conf` and assign a fixed set of DNS servers:
```ini
[Resolve]
DNS=<space separated sequence of DNS servers>
```

## Fixing snap applications
On boot, `snap` attempts to start up, but gets stopped soon after. After looking at `journalctl`, AppArmor is to blame. This is because snap needs read access to the root FS, which in our case makes a network request to our NFS server. AppArmor is configured by default to deny such requests however, hence snap is stopped. AppArmor can be configured to allow NFS access, but a temporary (not recommended) fix for this is to disable AppArmor by adding `apparmor=0` to the kernel's command line from the HTTP boot server

## Quietening boot-up
To have a clean boot screen, just add `quiet splash vt.handoff=7` to the kernel command line

At this point, I now have functional, fully-diskless, persistent VMs with a common FS and boot configuration. I've prepared this repo in hopes that it may be useful to others in the same situation, and as a reference guide for future use :)

If you found this helpful, do consider supporting me on Ko-fi!

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/J3J04QOOE)