#!/bin/sh
# Builds the sandbox images. Run from services/executor.
set -eu
tag="${SANDBOX_IMAGE_TAG:-1}"
for language in python cpp java node; do
  docker build --pull -t "codesync/sandbox-$language:$tag" "images/$language"
done
