#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  video-to-gs <input.mp4> <output-dir>

Environment variables:
  FRAME_FPS      Extracted frames per second. Default: 2
  MAX_FRAMES     Max frames to extract. 0 means unlimited. Default: 300
  TRAIN_ITERS    Iterations passed to train.py. Default: 7000
  RESIZE_IMAGES  1 to generate images_2/images_4/images_8. Default: 1
  CAMERA_MODEL   COLMAP camera model. Default: OPENCV
  COLMAP_NO_GPU  1 to disable COLMAP GPU usage. Default: auto
  CLEANUP_MODE   Post-process mode for the latest PLY. Default: off
  CLEANUP_MIN_ALPHA        Min sigmoid(opacity) for cleanup. Default: 0.01
  CLEANUP_MAX_SCALE        Max gaussian scale during cleanup. 0 disables. Default: 0
  CLEANUP_VOXEL_SIZE       Cleanup voxel size. 0 enables auto sizing. Default: 0
  CLEANUP_MIN_VOXEL_POINTS Ignore sparse voxels during cleanup. Default: 2
  KEEP_WORKDIR   1 to keep intermediate files. Default: 0
  WORK_ROOT      Intermediate working root. Default: /tmp/asset-gen
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 64
fi

if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  echo "expected arguments: <input.mp4> <output-dir>" >&2
  usage
  exit 64
fi

INPUT_VIDEO="$1"
OUTPUT_DIR="$2"

if [[ ! -f "$INPUT_VIDEO" ]]; then
  echo "input video not found: $INPUT_VIDEO" >&2
  exit 66
fi

FRAME_FPS="${FRAME_FPS:-2}"
MAX_FRAMES="${MAX_FRAMES:-300}"
TRAIN_ITERS="${TRAIN_ITERS:-7000}"
RESIZE_IMAGES="${RESIZE_IMAGES:-1}"
CAMERA_MODEL="${CAMERA_MODEL:-OPENCV}"
COLMAP_NO_GPU="${COLMAP_NO_GPU:-auto}"
CLEANUP_MODE="${CLEANUP_MODE:-off}"
CLEANUP_MIN_ALPHA="${CLEANUP_MIN_ALPHA:-0.01}"
CLEANUP_MAX_SCALE="${CLEANUP_MAX_SCALE:-0}"
CLEANUP_VOXEL_SIZE="${CLEANUP_VOXEL_SIZE:-0}"
CLEANUP_MIN_VOXEL_POINTS="${CLEANUP_MIN_VOXEL_POINTS:-2}"
KEEP_WORKDIR="${KEEP_WORKDIR:-0}"
WORK_ROOT="${WORK_ROOT:-/tmp/asset-gen}"
CONDA_DIR="${CONDA_DIR:-/opt/conda}"
GAUSSIAN_SPLATTING_DIR="${GAUSSIAN_SPLATTING_DIR:-/opt/gaussian-splatting}"
QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"

if [[ "$COLMAP_NO_GPU" == "auto" ]]; then
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    COLMAP_NO_GPU="1"
  else
    COLMAP_NO_GPU="0"
  fi
fi

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
export QT_QPA_PLATFORM
export XDG_RUNTIME_DIR

mkdir -p "$OUTPUT_DIR" "$WORK_ROOT"

video_name="$(basename "$INPUT_VIDEO")"
scene_name="${video_name%.*}"
timestamp="$(date +%Y%m%d-%H%M%S)"
scene_root="${WORK_ROOT}/${scene_name}-${timestamp}"
dataset_root="${scene_root}/scene"
model_root="${scene_root}/model"

cleanup() {
  if [[ "${KEEP_WORKDIR}" != "1" ]]; then
    rm -rf "$scene_root"
  fi
}

trap cleanup EXIT

mkdir -p "${dataset_root}/input" "$model_root"

ffmpeg_args=(
  -y
  -i "$INPUT_VIDEO"
  -vf "fps=${FRAME_FPS}"
  # COLMAP rejects some 16-bit/HDR PNGs emitted from phone videos.
  -pix_fmt rgb24
)

if [[ "$MAX_FRAMES" != "0" ]]; then
  ffmpeg_args+=(-frames:v "$MAX_FRAMES")
fi

ffmpeg_args+=("${dataset_root}/input/%06d.png")
ffmpeg "${ffmpeg_args[@]}"

source "${CONDA_DIR}/etc/profile.d/conda.sh"
conda activate gaussian_splatting

convert_args=(
  python
  convert.py
  -s "$dataset_root"
  --camera "$CAMERA_MODEL"
  --magick_executable /usr/local/bin/magick
)

if [[ "$COLMAP_NO_GPU" == "1" ]]; then
  convert_args+=(--no_gpu)
fi

if [[ "$RESIZE_IMAGES" == "1" ]]; then
  convert_args+=(--resize)
fi

(
  cd "$GAUSSIAN_SPLATTING_DIR"
  "${convert_args[@]}"
  python train.py -s "$dataset_root" -m "$model_root" --iterations "$TRAIN_ITERS"
)

if [[ ! -d "$model_root/point_cloud" ]]; then
  echo "point_cloud directory was not generated under $model_root" >&2
  exit 1
fi

latest_ply="$(find "$model_root/point_cloud" -type f -name point_cloud.ply | sort -V | tail -n 1)"
if [[ -z "$latest_ply" ]]; then
  echo "point_cloud.ply was not generated under $model_root" >&2
  exit 1
fi

final_ply="$latest_ply"
cleanup_succeeded="0"
if [[ "$CLEANUP_MODE" != "off" ]]; then
  cleanup_dir="${scene_root}/cleanup"
  mkdir -p "$cleanup_dir"
  cleaned_ply="${cleanup_dir}/point_cloud.cleaned.ply"
  cleanup_args=(
    python
    /usr/local/bin/cleanup-point-cloud.py
    "$latest_ply"
    "$cleaned_ply"
    --mode "$CLEANUP_MODE"
    --min-alpha "$CLEANUP_MIN_ALPHA"
    --max-scale "$CLEANUP_MAX_SCALE"
    --voxel-size "$CLEANUP_VOXEL_SIZE"
    --min-voxel-points "$CLEANUP_MIN_VOXEL_POINTS"
  )

  if "${cleanup_args[@]}"; then
    final_ply="$cleaned_ply"
    cleanup_succeeded="1"
  else
    echo "cleanup failed, falling back to raw point cloud" >&2
  fi
fi

if [[ "$cleanup_succeeded" == "1" ]]; then
  cp "$latest_ply" "$OUTPUT_DIR/point_cloud.raw.ply"
else
  rm -f "$OUTPUT_DIR/point_cloud.raw.ply"
fi

cp "$final_ply" "$OUTPUT_DIR/point_cloud.ply"

if [[ -f "$model_root/cameras.json" ]]; then
  cp "$model_root/cameras.json" "$OUTPUT_DIR/cameras.json"
fi

if [[ -f "$model_root/cfg_args" ]]; then
  cp "$model_root/cfg_args" "$OUTPUT_DIR/cfg_args"
fi

mkdir -p "$OUTPUT_DIR/model"
rm -rf "$OUTPUT_DIR/model/point_cloud"
cp -r "$model_root/point_cloud" "$OUTPUT_DIR/model/point_cloud"

if [[ "$cleanup_succeeded" == "1" ]]; then
  latest_output_ply="$(find "$OUTPUT_DIR/model/point_cloud" -type f -name point_cloud.ply | sort -V | tail -n 1)"
  if [[ -n "$latest_output_ply" ]]; then
    cp "$final_ply" "$latest_output_ply"
  fi
fi

if [[ -d "$dataset_root/sparse" ]]; then
  rm -rf "$OUTPUT_DIR/model/sparse"
  cp -r "$dataset_root/sparse" "$OUTPUT_DIR/model/sparse"
fi

printf 'generated %s\n' "$OUTPUT_DIR/point_cloud.ply"
