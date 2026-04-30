#!/bin/bash
# Wrapper for rpmbuild to fix fpm's invalid --target format and optimize compression
# 1. Fix x86_64-unknown-linux -> x86_64-linux
# 2. Replace slow xz compression with fast gzip
# 3. Use all CPU cores

export RPM_BUILD_NCPUS=$(nproc 2>/dev/null || echo 4)

args=()
skip_next=false
for arg in "$@"; do
    if $skip_next; then
        skip_next=false
        # Translate x86_64-unknown-linux to x86_64-linux
        args+=("$(echo "$arg" | sed 's/-unknown-linux/-linux/g')")
        continue
    fi
    if [ "$arg" = "--target" ]; then
        args+=("$arg")
        skip_next=true
        continue
    fi
    # Replace xz/xzmt compression with fast gzip
    if [ "$arg" = "xzmt" ] || [ "$arg" = "xz" ]; then
        args+=("gzip")
        continue
    fi
    args+=("$arg")
done

exec /usr/bin/rpmbuild "${args[@]}"
