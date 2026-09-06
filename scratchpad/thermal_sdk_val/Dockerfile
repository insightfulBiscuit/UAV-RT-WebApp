FROM --platform=linux/amd64 ubuntu:22.04

# Minimal deps for DJI Thermal SDK v1.8 on Linux x64
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libc6 libgcc-s1 libstdc++6 libgomp1 python3 python3-numpy && \
    rm -rf /var/lib/apt/lists/*

# Layout mirrors the delivery's own tsdk-core/lib + utility/bin layout
COPY sdk_lib/ /opt/dji_sdk/lib/
COPY sdk_bin/dji_irp /opt/dji_sdk/bin/dji_irp

ENV LD_LIBRARY_PATH=/opt/dji_sdk/lib
ENV PATH=/opt/dji_sdk/bin:$PATH
WORKDIR /work
