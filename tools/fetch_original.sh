#!/bin/sh
# Download the original Slune 1.0.14 and Soya 0.12 sources (GPL) from the Debian archive
# into the directory given as $1 (default: ./original), then regenerate web/assets.
set -e
DEST=${1:-original}
mkdir -p "$DEST"
cd "$DEST"
curl -fsSLO http://archive.debian.org/debian/pool/main/s/slune/slune_1.0.14.orig.tar.gz
curl -fsSLO http://archive.debian.org/debian/pool/main/s/soya/soya_0.12.orig.tar.gz
# MD5 published in Debian's slune_1.0.14-2.dsc
python3 -I -c 'import hashlib,sys; h=hashlib.md5(open(sys.argv[1],"rb").read()).hexdigest(); sys.exit(h!="015aabbeac982aaf7c58d345e9cfdca1")' slune_1.0.14.orig.tar.gz \
  || { echo "checksum mismatch for slune_1.0.14.orig.tar.gz" >&2; exit 1; }
tar xzf slune_1.0.14.orig.tar.gz
tar xzf soya_0.12.orig.tar.gz
cd - >/dev/null
python3 -I "$(dirname "$0")/export_assets.py" "$DEST/Slune-1.0.14" "$(dirname "$0")/../web/assets"
