# syntax=docker/dockerfile:1
#
# LandWizard GIS toolbox: PostGIS + GDAL + tippecanoe + pmtiles CLI.
# No Python, no Node: the build scripts run on the host and call these tools
# through `docker compose exec gis <tool> ...`, with data mounted at /data.

# PostgreSQL 18 + PostGIS 3.7 on Debian trixie (GDAL 3.10, tippecanoe 2.53 in apt).
FROM postgis/postgis:18-3.7

ARG PMTILES_VERSION=1.31.2
ARG PMTILES_SHA256_AMD64=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
ARG PMTILES_SHA256_ARM64=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gdal-bin \
      tippecanoe \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# pmtiles CLI (Go binary from protomaps/go-pmtiles), checksum-pinned.
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sum="$PMTILES_SHA256_AMD64" ;; \
      arm64) arch=arm64;  sum="$PMTILES_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    file="go-pmtiles_${PMTILES_VERSION}_Linux_${arch}.tar.gz"; \
    curl -fsSL -o "/tmp/$file" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/$file"; \
    echo "$sum  /tmp/$file" | sha256sum -c -; \
    tar -xzf "/tmp/$file" -C /usr/local/bin pmtiles; \
    rm "/tmp/$file"; \
    pmtiles version

WORKDIR /data
