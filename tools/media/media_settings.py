"""Pinned models, cloud resources and prices for the media generator.

Safe to import anywhere: no Modal, no PyTorch, no network.
"""
from __future__ import annotations

# --- Names -----------------------------------------------------------------
APP_NAME = "beta-sequence-media"
ART_WEIGHTS_VOLUME = "beta-sequence-art-weights"   # ours: picture + cut-out models
WAN_WEIGHTS_VOLUME = "beta-sequence-wan-weights"   # ours: Wan2.2 image-to-video
# Another project's verified LTX-2.5 cache. Mounted READ-ONLY, never written.
# It only exists on the owner's Modal account; when it is there it is used as before.
LTX_CACHE_VOLUME = "morriton-ltx-2-5-model-cache"
# Ours: LTX-2.5 downloaded by --prepare on any other Modal account.
LTX_WEIGHTS_VOLUME = "beta-sequence-ltx-weights"
# Modal secret holding a Hugging Face read token (key HF_TOKEN), needed because LTX-2.5 asks
# people to accept its licence on Hugging Face first. Another secret name can be given in the
# MEDIA_HF_SECRET environment variable. The token itself is never read or printed by this tool.
HF_SECRET_NAME = "beta-sequence-huggingface"

# Environment variables (all optional).
ENV_HF_SECRET = "MEDIA_HF_SECRET"                     # name of the Modal secret with HF_TOKEN
ENV_IGNORE_LTX_CACHE = "MEDIA_IGNORE_LTX_CACHE"       # for testing: "1" = act as if the owner's cache was missing
ENV_LTX_VOLUME = "MEDIA_LTX_VOLUME"                   # for testing: another name for our own LTX volume

# --- Picture model: Z-Image-Turbo (Apache-2.0, ungated) ----------------------
ZIMAGE_REPO = "Tongyi-MAI/Z-Image-Turbo"
ZIMAGE_REVISION = "f332072aa78be7aecdf3ee76d5c247082da564a6"
ZIMAGE_LICENSE = "apache-2.0"
# LFS files at the pinned revision: (size in bytes, sha256). Checked after download.
ZIMAGE_FILES = {
    "text_encoder/model-00001-of-00003.safetensors": (3957900840, "328a91d3122359d5547f9d79521205bc0a46e1f79a792dfe650e99fc2d651223"),
    "text_encoder/model-00002-of-00003.safetensors": (3987450520, "6cd087b316306a68c562436b5492edbcf6e16c6dba3a1308279caa5a58e21ca5"),
    "text_encoder/model-00003-of-00003.safetensors": (99630640, "7ca841ee75b9c61267c0c6148fd8d096d3d21b6d3e161256a9b878154f91fc52"),
    "tokenizer/tokenizer.json": (11422654, "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"),
    "transformer/diffusion_pytorch_model-00001-of-00003.safetensors": (9973693184, "95facd593e2549e8252acb571c653d57f7ddb7f1060d4e81712f152555a88804"),
    "transformer/diffusion_pytorch_model-00002-of-00003.safetensors": (9973714824, "a4bbe43ee184a1fb5af4b412d27555f532893bdc3165b1149e304ed82b5d7015"),
    "transformer/diffusion_pytorch_model-00003-of-00003.safetensors": (4672282880, "aba4e37a590e63210878160a718d916d80398f4e1f78ab6c9b2b2a00d92769fa"),
    "vae/diffusion_pytorch_model.safetensors": (167666902, "f5b59a26851551b67ae1fe58d32e76486e1e812def4696a4bea97f16604d40a3"),
}
ZIMAGE_IGNORE = ["assets/*", "*.md", ".gitattributes"]

# --- Cut-out model: BiRefNet matting (MIT, ungated, author's own account) -----
BIREFNET_REPO = "ZhengPeng7/BiRefNet-matting"
BIREFNET_REVISION = "eccde0a8cbdce7ac5fecfeb06340fe7b949e85d9"
BIREFNET_LICENSE = "mit"
BIREFNET_FILES = {
    "model.safetensors": (884878856, "a9875de5b1e6c8eb5fdaa8c727a82927ce442cdc87ba3abee6a77e6fa46c25bb"),
}
BIREFNET_INPUT_SIZE = 1024

# --- Motion model: LTX-2.5 (LTX-2.x Community License, gated on HF) ----------
LTX_CODE_REPOSITORY = "https://github.com/Lightricks/LTX-2.git"
LTX_CODE_REVISION = "a95ab856bf29407b6b066ede0abe1846050db56c"
LTX_REPO = "Lightricks/LTX-2.5"
LTX_REVISION = "5e6e71018ee1756ed329b697a7b4aedc934dfce9"
LTX_LICENSE = "ltx-2.x-community-license (free below USD 10M yearly revenue and for non-commercial hobby use)"
LTX_GATED = True        # Hugging Face asks for a sign-in and a click on "accept" (checked 2026-11-11: gated "auto")
LTX_PAGE = f"https://huggingface.co/{LTX_REPO}"
LTX_FILES = {
    "transformer": ("diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors", 42018190584,
                    "792a2bad501ca03262c0bc2ce7a2949e85b142ce18e30894aad5bc849c8e7584"),
    "text_encoder": ("text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", 26263858182,
                     "ef7243612fdae7a75cb4d5cee9433e81380675fb6c213bd98ae74a9cd16561d1"),
    "video_vae": ("vae/ltx-2.5-video-vae-conv-bf16.safetensors", 1452269922,
                  "685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d"),
    "audio_vae": ("vae/ltx-2.5-audio-vae-bf16.safetensors", 364866540,
                  "c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5"),
    "spatial_upsampler": ("latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", 995778752,
                          "eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8"),
    "distilled_lora": ("loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors", 8899889568,
                       "86370bbf79a9eb4edaa158907e2b48a5188fe4c5dc8ce30c7eb8f2f131a9bbf5"),
}

# --- Motion model 2: Wan2.2 image-to-video A14B (Apache-2.0, ungated) ------------
# Exact file list with checksums: wan_files.json next to this file.
WAN_REPO = "Wan-AI/Wan2.2-I2V-A14B-Diffusers"
WAN_REVISION = "596658fd9ca6b7b71d5057529bbf319ecbc61d74"
WAN_LICENSE = "apache-2.0"
WAN_WIDTH, WAN_HEIGHT = 544, 720               # 3:4, about Wan's 480p pixel count, divisible by 16

# --- Software pins ------------------------------------------------------------
TORCH_PACKAGES = ("torch==2.9.1", "torchvision==0.24.1", "torchaudio==2.9.1")
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
ART_PACKAGES = (
    "diffusers==0.42.1", "transformers==5.22.2", "accelerate==1.15.0", "safetensors==0.8.0",
    "timm==1.0.31", "kornia==0.9.0", "einops==0.8.2", "numpy==2.2.6", "Pillow==11.3.0", "scipy==1.17.0",
)
LTX_PACKAGES = (
    "transformers==5.14.1", "huggingface-hub==1.29.0", "tokenizers==0.22.2",
    "safetensors==0.8.0", "accelerate==1.14.0", "numpy==2.2.6", "scipy==1.17.0",
    "av==18.1.0", "Pillow==11.3.0", "einops==0.8.2", "openimageio==3.1.17.0",
    "cloudpickle==3.1.2", "tqdm==4.70.0", "uv_build==0.9.30",
)

# --- Canvas, timing and look --------------------------------------------------
# Everything is 3:4 portrait, the closest shape Seedance 2.5 offers to a dancer.
FPS = 24
KEYFRAME_WIDTH, KEYFRAME_HEIGHT = 834, 1112    # keyframe.png: the cut-out at Seedance 720p size
MOTION_WIDTH, MOTION_HEIGHT = 768, 1024        # LTX two-stage canvas (both divisible by 64)
MOTION_FRAMES = 97                             # 8n+1; last frame repeats the first pose
OUTPUT_WIDTH, OUTPUT_HEIGHT = 540, 720         # final clip and stills
PICTURE_WIDTH, PICTURE_HEIGHT = 960, 1280      # Z-Image drawing size (3:4)

# --- Hosted dance engine: OpenRouter video models (paid per clip, owner's key) -------
OPENROUTER_API = "https://openrouter.ai/api/v1"
SEEDANCE_MODEL = "bytedance/seedance-2.5"                  # default hosted model
SEEDANCE_SECONDS = 5
SEEDANCE_FPS = 24                                          # used for the video-token count
# Catalogue prices read 2026-11-11; the live catalogue is checked again before every clip.
HOSTED_PRICES_READ = {
    "date": "2026-11-11",
    "bytedance/seedance-2.5": "USD 0.0000107 per video token (no audio)",
    "minimax/hailuo-3-max": "USD 0.05 per second at 480p, 0.08 per second at 768p",
}
FIGURE_HEIGHT_SHARE = 0.76                     # figure height as share of the canvas
FIGURE_MAX_WIDTH_SHARE = 0.80
FEET_LINE = 0.92                               # where the feet stand, from the top
LTX_SETTINGS = {
    "quantization": "fp8-cast", "offload": "cpu", "num_inference_steps": 30,
    "video_cfg": 3.0, "audio_cfg": 7.0, "distilled_lora_strength": 1.0, "image_crf": 18,
}
ZIMAGE_STEPS = 9
EXPRESSION_STRENGTH = 0.55

# --- Cloud resources (request = limit, so billing is bounded) -------------------
ART_GPU = "L40S"
ART_CPU = 4
ART_MEMORY_MIB = 32768
ART_TIMEOUT = 900
MOTION_GPU = "H200"
MOTION_CPU = 4
MOTION_MEMORY_MIB = 131072
MOTION_TIMEOUT = 900
PREPARE_CPU = 2
PREPARE_MEMORY_MIB = 8192
PREPARE_TIMEOUT = 2400
DOWNLOAD_CPU = 4                               # the big downloads (Wan2.2, LTX-2.5)
DOWNLOAD_MEMORY_MIB = 16384
DOWNLOAD_TIMEOUT = 3600

# --- Published prices (https://modal.com/pricing, checked 2026-11-10) ---------
PRICES_CHECKED = "2026-11-10"
GPU_USD_PER_SECOND = {"H200": 0.001261, "H100": 0.001097, "A100-80GB": 0.000694, "L40S": 0.000542,
                      "A10": 0.000306, "L4": 0.000222, "T4": 0.000164, None: 0.0}
CPU_CORE_USD_PER_SECOND = 0.0000131
MEMORY_GIB_USD_PER_SECOND = 0.00000222


def rate_per_second(gpu: str | None, cpu: float, memory_mib: int) -> float:
    """Price of one second of a container with these requested resources."""
    return GPU_USD_PER_SECOND[gpu] + cpu * CPU_CORE_USD_PER_SECOND + memory_mib / 1024 * MEMORY_GIB_USD_PER_SECOND


ART_RATE = rate_per_second(ART_GPU, ART_CPU, ART_MEMORY_MIB)
MOTION_RATE = rate_per_second(MOTION_GPU, MOTION_CPU, MOTION_MEMORY_MIB)
PREPARE_RATE = rate_per_second(None, PREPARE_CPU, PREPARE_MEMORY_MIB)
WAN_PREPARE_RATE = rate_per_second(None, DOWNLOAD_CPU, DOWNLOAD_MEMORY_MIB)
LTX_PREPARE_RATE = WAN_PREPARE_RATE

# One-time downloads: size in GB and seconds (download + checksum check).
# Pictures and Wan were measured on 2026-11-11. LTX is an estimate scaled from the Wan download
# (same machine, same method); it could not be measured because the owner's account already had it.
PREPARE_GB = {
    "art": round((sum(size for size, _ in ZIMAGE_FILES.values())
                  + sum(size for size, _ in BIREFNET_FILES.values())) / 1e9, 1),
    "ltx": round(sum(size for _, size, _ in LTX_FILES.values()) / 1e9, 1),
    "wan": 126.0,
}
PREPARE_SECONDS = {"art": 282, "ltx": 600, "wan": 754}
PREPARE_RATES = {"art": PREPARE_RATE, "ltx": LTX_PREPARE_RATE, "wan": WAN_PREPARE_RATE}
SOFTWARE_BUILD_USD = 0.10      # building the cloud software the first time (estimate)

# Dance engines that run on our own Modal account (no other account or key needed),
# with typical seconds of H200 time per clip including start-up and model loading.
MODAL_DANCE_SECONDS = {"ltx": 240, "wan": 460}
DEFAULT_ENGINE = "ltx"   # chosen after a side-by-side test; see docs/MEDIA.md

# Upper bound used before starting: art 240 s, motion 420 s, cut-out 240 s.
WORST_CASE_USD = round(240 * ART_RATE + 420 * MOTION_RATE + 240 * ART_RATE, 2)


def model_records(engine: str = "ltx") -> list[dict]:
    """Model list written into media.json provenance (pinned open weights only)."""
    records = [
        {"repo": ZIMAGE_REPO, "revision": ZIMAGE_REVISION, "license": ZIMAGE_LICENSE, "role": "character picture"},
        {"repo": BIREFNET_REPO, "revision": BIREFNET_REVISION, "license": BIREFNET_LICENSE, "role": "background removal"},
    ]
    if engine == "ltx":
        records.insert(1, {"repo": LTX_REPO, "revision": LTX_REVISION, "license": LTX_LICENSE, "role": "dance motion",
                           "code": f"{LTX_CODE_REPOSITORY}@{LTX_CODE_REVISION}"})
    if engine == "wan":
        records.insert(1, {"repo": WAN_REPO, "revision": WAN_REVISION, "license": WAN_LICENSE, "role": "dance motion"})
    return records


def hosted_record(model: str, canonical_slug: str) -> dict:
    """Hosted dance model: no weights we can pin, so it is recorded by its dated catalogue name."""
    return {"service": "OpenRouter", "model": model, "version": canonical_slug, "role": "dance motion",
            "weights": "hosted by the model's maker, not downloaded"}
