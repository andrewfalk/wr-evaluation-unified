#!/bin/sh
# Load Docker images from the offline package into the local Docker daemon.
# Run from the package root directory after extracting the offline package.
#
# Usage:
#   bash scripts/import-images.sh [path/to/wr-images.tar]
#
# Default path: ./images/wr-images.tar

set -e

IMAGES_PATH="${1:-./images/wr-images.tar}"

if [ ! -f "$IMAGES_PATH" ]; then
    echo "ERROR: Images archive not found: $IMAGES_PATH" >&2
    echo "Run from the package root directory, or specify the correct path." >&2
    exit 1
fi

SIZE_MB=$(du -m "$IMAGES_PATH" | cut -f1)
echo "Loading Docker images from: $IMAGES_PATH (${SIZE_MB} MB)"
echo "This may take a minute..."

docker load -i "$IMAGES_PATH"

echo ""
echo "Done. Images loaded successfully."
echo "Verify with: docker images | grep wr-"
