include Makefile.config

CWD := $(shell pwd)

CLIENT := $(CWD)/client
BOOT_SCRIPT_TEMPLATE := $(CLIENT)/init-template.ipxe
BOOT_SCRIPT := $(CLIENT)/init.ipxe

IPXE_SRC := $(CLIENT)/ipxe/src

$(CLIENT)/ipxe.iso:
#### Substitute SERVER_HOST and PORT
	cat $(BOOT_SCRIPT_TEMPLATE) | sed -e 's/SERVER_HOST/$(SERVER_HOST)/' -e 's/SERVER_PORT/$(SERVER_PORT)/' > $(BOOT_SCRIPT)

#### Build iPXE
	$(MAKE) -C $(IPXE_SRC) \
		EMBED=$(BOOT_SCRIPT) \
		bin-i386-efi/ipxe.efi bin-x86_64-efi/ipxe.efi bin/ipxe.lkrn

#### BUG: Build iPXE ISO separately for EFI
	$(IPXE_SRC)/util/genfsimg \
		-o $(CLIENT)/ipxe.iso \
		-s $(BOOT_SCRIPT) \
		$(IPXE_SRC)/bin-i386-efi/ipxe.efi $(IPXE_SRC)/bin-x86_64-efi/ipxe.efi $(IPXE_SRC)/bin/ipxe.lkrn

clean:
	rm $(CLIENT)/ipxe.iso
	$(MAKE) -C $(IPXE_SRC) clean

.PHONY: clean $(CLIENT)/ipxe.iso