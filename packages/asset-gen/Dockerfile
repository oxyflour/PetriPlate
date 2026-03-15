#FROM nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04
FROM docker.m.daocloud.io/nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04

ARG BUILD_PROXY=http://proxy.yff.me:8124
ARG UBUNTU_MIRROR_HOST=mirrors.tuna.tsinghua.edu.cn
ARG CONDA_MIRROR=
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG TORCH_CUDA_ARCH_LIST=6.1;7.0;7.5;8.0;8.6+PTX

ENV DEBIAN_FRONTEND=noninteractive \
    CONDA_DIR=/opt/conda \
    GAUSSIAN_SPLATTING_DIR=/opt/gaussian-splatting \
    PATH=/opt/conda/bin:$PATH \
    HTTP_PROXY=${BUILD_PROXY} \
    HTTPS_PROXY=${BUILD_PROXY} \
    http_proxy=${BUILD_PROXY} \
    https_proxy=${BUILD_PROXY} \
    TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST} \
    NO_PROXY=127.0.0.1,localhost \
    no_proxy=127.0.0.1,localhost

RUN set -eux; \
    ubuntu_mirror="https://${UBUNTU_MIRROR_HOST}"; \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -ri \
      -e "s@https?://(archive|security).ubuntu.com/ubuntu/?@${ubuntu_mirror}/ubuntu/@g" \
      -e "s@https?://ports.ubuntu.com/ubuntu-ports/?@${ubuntu_mirror}/ubuntu-ports/@g" \
      '{}' +; \
    if [ -n "${BUILD_PROXY}" ]; then \
      printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "${BUILD_PROXY}" "${BUILD_PROXY}" > /etc/apt/apt.conf.d/99build-proxy; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      cmake \
      colmap \
      curl \
      ffmpeg \
      git \
      imagemagick \
      libgl1 \
      libglib2.0-0 \
      libsm6 \
      libxext6 \
      libxrender1; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    pip_host="$(printf '%s' "${PIP_INDEX_URL}" | sed -E 's@https?://([^/]+)/?.*@\1@')"; \
    printf '%s\n' \
      '[global]' \
      "index-url = ${PIP_INDEX_URL}" \
      'extra-index-url = https://pypi.org/simple' \
      "trusted-host = ${pip_host}" \
      'timeout = 120' > /etc/pip.conf; \
    printf '%s\n' \
      'show_channel_urls: true' \
      'remote_connect_timeout_secs: 30' \
      'remote_read_timeout_secs: 120' \
      'remote_max_retries: 10' > /root/.condarc; \
    if [ -n "${CONDA_MIRROR}" ]; then \
      printf '%s\n' \
        'default_channels:' \
        "  - ${CONDA_MIRROR}/pkgs/main" \
        "  - ${CONDA_MIRROR}/pkgs/r" \
        "  - ${CONDA_MIRROR}/pkgs/msys2" \
        'custom_channels:' \
        "  conda-forge: ${CONDA_MIRROR}/cloud" \
        "  pytorch: ${CONDA_MIRROR}/cloud" \
        "  nvidia: ${CONDA_MIRROR}/cloud" >> /root/.condarc; \
    fi; \
    if [ -n "${BUILD_PROXY}" ]; then \
      git config --global http.proxy "${BUILD_PROXY}"; \
      git config --global https.proxy "${BUILD_PROXY}"; \
      printf '%s\n' \
        'proxy_servers:' \
        "  http: ${BUILD_PROXY}" \
        "  https: ${BUILD_PROXY}" >> /root/.condarc; \
    fi

ARG MINIFORGE_VERSION=24.11.3-0
RUN curl -fsSL "https://github.com/conda-forge/miniforge/releases/download/${MINIFORGE_VERSION}/Miniforge3-Linux-x86_64.sh" -o /tmp/miniforge.sh && \
    bash /tmp/miniforge.sh -b -p "${CONDA_DIR}" && \
    rm /tmp/miniforge.sh && \
    conda clean -afy

WORKDIR /opt
RUN set -eux; \
    for attempt in 1 2 3; do \
      rm -rf "${GAUSSIAN_SPLATTING_DIR}"; \
      if git -c http.version=HTTP/1.1 -c submodule.fetchJobs=1 clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/graphdeco-inria/gaussian-splatting.git "${GAUSSIAN_SPLATTING_DIR}"; then \
        break; \
      fi; \
      if [ "${attempt}" -eq 3 ]; then \
        exit 1; \
      fi; \
      sleep 5; \
    done; \
    cd "${GAUSSIAN_SPLATTING_DIR}" && \
    sed -i '/^  - cudatoolkit=11\.6$/d' environment.yml && \
    sed -i '/^  - pytorch=1\.12\.1$/d' environment.yml && \
    sed -i '/^  - torchaudio=0\.12\.1$/d' environment.yml && \
    sed -i '/^  - torchvision=0\.13\.1$/d' environment.yml && \
    sed -i '/^  - tqdm$/a\  - ninja' environment.yml && \
    sed -i '/^    - submodules\/diff-gaussian-rasterization$/d' environment.yml && \
    sed -i '/^    - submodules\/simple-knn$/d' environment.yml && \
    sed -i '/^    - submodules\/fused-ssim$/d' environment.yml && \
    sed -i '/^  - pip:$/a\    - torchvision==0.13.1+cu116' environment.yml && \
    sed -i '/^  - pip:$/a\    - torch==1.12.1+cu116' environment.yml && \
    sed -i '/^  - pip:$/a\    - --extra-index-url https://download.pytorch.org/whl/cu116' environment.yml

WORKDIR ${GAUSSIAN_SPLATTING_DIR}
RUN --mount=type=cache,target=/opt/conda/pkgs set -eux; \
    for attempt in 1 2 3; do \
      if conda env create --file environment.yml; then \
        break; \
      fi; \
      if [ "${attempt}" -eq 3 ]; then \
        exit 1; \
      fi; \
      conda env remove -n gaussian_splatting -y || true; \
      rm -rf "${CONDA_DIR}/envs/gaussian_splatting"; \
      sleep 5; \
    done

RUN . "${CONDA_DIR}/etc/profile.d/conda.sh" && \
    conda activate gaussian_splatting && \
    pip install --no-build-isolation \
      submodules/diff-gaussian-rasterization \
      submodules/simple-knn \
      submodules/fused-ssim

RUN rm -f /etc/apt/apt.conf.d/99build-proxy && \
    git config --global --unset-all http.proxy || true
RUN git config --global --unset-all https.proxy || true

ENV HTTP_PROXY= \
    HTTPS_PROXY= \
    http_proxy= \
    https_proxy=

# Ubuntu's ImageMagick package exposes `mogrify`, while convert.py expects a
# `magick` launcher. This shim forwards `magick mogrify ...` to `mogrify ...`.
RUN cat <<'EOF' >/usr/local/bin/magick
#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo "usage: magick <subcommand> [args...]" >&2
  exit 64
fi
subcommand="$1"
shift
exec "${subcommand}" "$@"
EOF

RUN chmod +x /usr/local/bin/magick

COPY video-to-gs.sh /usr/local/bin/video-to-gs
COPY cleanup-point-cloud.py /usr/local/bin/cleanup-point-cloud.py
RUN chmod +x /usr/local/bin/video-to-gs
RUN chmod +x /usr/local/bin/cleanup-point-cloud.py

VOLUME ["/data"]
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/video-to-gs"]
CMD ["--help"]
