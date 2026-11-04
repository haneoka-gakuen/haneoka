FROM cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8
COPY entrypoint.sh /haneoka-local-egress.sh
ENTRYPOINT ["/bin/sh", "/haneoka-local-egress.sh"]
