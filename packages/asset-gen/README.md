# asset-gen

This image wraps the official `graphdeco-inria/gaussian-splatting` pipeline so a
single container run can:

1. extract frames from an `mp4` with `ffmpeg`
2. build a COLMAP reconstruction with `convert.py`
3. train a 3D Gaussian Splatting model with `train.py`
4. copy the latest `point_cloud.ply` into the output directory

Requirements:

- an NVIDIA GPU for practical training speed
- Docker with `--gpus all`
- acceptance of the upstream `gaussian-splatting` non-commercial research license

## Build

```bash
docker build -t petri-asset-gen packages/asset-gen
```

The Dockerfile is configured for mainland China by default:

- Ubuntu packages use `mirrors.tuna.tsinghua.edu.cn`
- overseas resources use the build proxy `http://proxy.yff.me:8124`
- pip uses the Tsinghua mirror first, with PyPI as fallback
- conda uses the upstream channels through the proxy by default
- BuildKit caches conda package downloads so retries do not restart from zero

Override them if needed:

```bash
docker build \
  --build-arg BUILD_PROXY=http://proxy.yff.me:8124 \
  --build-arg UBUNTU_MIRROR_HOST=mirrors.tuna.tsinghua.edu.cn \
  --build-arg CONDA_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/anaconda \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  --build-arg TORCH_CUDA_ARCH_LIST="6.1;7.0;7.5;8.0;8.6+PTX" \
  -t petri-asset-gen packages/asset-gen
```

Leave `CONDA_MIRROR` empty to keep the default upstream-through-proxy behavior.
Override `TORCH_CUDA_ARCH_LIST` to match your target GPU(s) if you want faster extension builds.

## Run

```bash
docker run --gpus all --rm \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  petri-asset-gen /input/demo.mp4 /output/demo
```

The command writes:

- `/output/demo/point_cloud.ply`
- `/output/demo/model/point_cloud/...`
- optional metadata such as `cameras.json`

## Tunables

```bash
docker run --gpus all --rm \
  -e FRAME_FPS=1 \
  -e MAX_FRAMES=240 \
  -e TRAIN_ITERS=7000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  petri-asset-gen /input/demo.mp4 /output/demo
```

Available environment variables:

- `FRAME_FPS`: extracted frames per second
- `MAX_FRAMES`: max frames to extract, `0` means unlimited
- `TRAIN_ITERS`: optimization iterations passed to `train.py`
- `RESIZE_IMAGES`: `1` to generate multi-scale image folders
- `CAMERA_MODEL`: COLMAP camera model, default `OPENCV`
- `COLMAP_NO_GPU`: `1` to disable COLMAP GPU usage, default auto-detects headless containers and falls back to CPU
- `CLEANUP_MODE`: `object` keeps the largest connected gaussian cluster for single-object captures, default `off`
- `CLEANUP_MIN_ALPHA`: minimum `sigmoid(opacity)` used by cleanup, default `0.01`
- `CLEANUP_MAX_SCALE`: optional max gaussian scale for cleanup, `0` disables it
- `CLEANUP_VOXEL_SIZE`: cleanup voxel size, `0` picks an automatic value from the robust bounding box
- `CLEANUP_MIN_VOXEL_POINTS`: ignore sparse cleanup voxels smaller than this threshold, default `2`
- `KEEP_WORKDIR`: `1` to preserve intermediate files
- `WORK_ROOT`: intermediate working directory inside the container

Notes:

- extracted frames are forced to 8-bit RGB so COLMAP can read HDR/10-bit phone videos
- in headless containers, COLMAP defaults to CPU feature extraction/matching unless you explicitly set `COLMAP_NO_GPU=0`
- single-object turntable captures often benefit from `CLEANUP_MODE=object`, which writes the cleaned result to `/output/.../point_cloud.ply` and preserves the unfiltered latest file as `/output/.../point_cloud.raw.ply`
