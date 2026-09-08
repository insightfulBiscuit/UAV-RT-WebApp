# Realtime M400/H30T DEIMv2 Inference Report

- Weight path: `DEIMv2/weight/deimv2_dinov3_s_coco.pth`
- Config path: `DEIMv2/configs/deimv2/deimv2_dinov3_s_coco.yml`
- Video stream read: success via `rtsp://127.0.0.1:8554/live/m400`
- Model loaded: success
- Realtime AI inference display: success, script processed 3 frames and opened the OpenCV display path during validation
- Runtime device: CUDA GPU
- GPU: NVIDIA GeForce RTX 3060 Laptop GPU
- PyTorch: `2.5.1+cu121`
- Result screenshot: `DEIMv2/realtime_m400_result.jpg`
- Label mapping: fixed to use DEIMv2 official `mscoco_label2category -> mscoco_category2name` mapping from `engine.data.dataset.coco_dataset`.

Notes:
- Existing `deepnets` environment was present but did not contain a usable PyTorch install.
- The first `deimv2_rt` environment installed a CPU PyTorch wheel and was removed.
- `deimv2_rt` was recreated with CUDA PyTorch (`torch 2.5.1+cu121`, `torchvision 0.20.1+cu121`).
- Initial realtime script used an incorrect hard-coded COCO label table for deploy-mode outputs. DEIMv2 `postprocessor.deploy()` returns internal labels `0..79`; the script now maps those internal labels to official COCO category names through the project mapping.
- Verification examples: internal `0 -> person`, `49 -> orange`, `50 -> broccoli`, `56 -> chair`.
- The saved validation frame showed `det=0` at the default confidence threshold in one short test, but model inference completed successfully.
