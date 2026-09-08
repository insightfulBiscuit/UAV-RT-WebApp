# Model Settings and Detection Targets

This file summarizes the detector settings, input handling, trained weights, and target classes for the current DJI benchmark models.

## Detection Targets

All current RGB and IR detectors use the same 10-class detection head:

| ID | Class | Meaning |
| ---: | --- | --- |
| 0 | `vehicle` | Vehicles and vehicle-like objects |
| 1 | `tree` | Trees |
| 2 | `metal_fixture` | Metal fixtures or metal structures |
| 3 | `green_grass` | Green grass or healthy vegetation |
| 4 | `dry_grass` | Dry grass or dry vegetation |
| 5 | `person` | People |
| 6 | `tent_tarp` | Tents, tarps, or similar covers |
| 7 | `plastic_waste` | Plastic waste and merged cardboard/wood waste labels |
| 8 | `fire` | Fire/flame |
| 9 | `smoke` | Smoke |

Label cleanup used for the IR dataset:

- `metal_stucture` and `metal_structure` are mapped to `metal_fixture`.
- `cardboard_wood_waste` is mapped to `plastic_waste`.
- The current IR dataset has no `fire` or `smoke` annotations, but the model head still keeps these two classes for compatibility with the RGB benchmark.

## DEIMv2-S RGB Model

Purpose: RGB drone/D-Fire detection model for the mixed RGB benchmark.

Weight:

`/home/starlab/Desktop/Kangnan/DJI/DEIMv2/outputs/deimv2_dinov3_s_dji_fire_50e_workers0/best_stg2.pth`

Config:

`/home/starlab/Desktop/Kangnan/DJI/DEIMv2/configs/deimv2/deimv2_dinov3_s_dji_fire_50e_v3.yml`

Dataset:

`/home/starlab/Desktop/Kangnan/DJI/final_mixed_rgb_640_yolo_coco_dataset_3`

Key settings:

- Model family: `DEIMv2-S`
- Backbone: DINOv3 STA small setup, `vit_tiny`
- Input size: `640x640`
- Classes: 10
- Category ids: zero-based COCO ids, `0..9`
- Epochs: 50
- Total batch size: 32
- Optimizer: AdamW
- Main learning rate: `0.0005`
- DINOv3 backbone learning rate: `0.000025`
- Weight decay: `0.0001`
- Warmup iterations: 750
- Scheduler: flat-cosine
- Flat epoch: 24
- No-augmentation final phase: last 5 epochs
- Main augmentations: Mosaic, RandomPhotometricDistort, RandomZoomOut, RandomIoUCrop, RandomHorizontalFlip, multi-scale resize
- Training output directory: `DEIMv2/outputs/deimv2_dinov3_s_dji_fire_50e_workers0`

## DEIMv2-S IR Model

Purpose: IR/thermal detection model for the merged IR benchmark and IR video inference.

Weight:

`/home/starlab/Desktop/Kangnan/DJI/DEIMv2/outputs/deimv2_dinov3_s_dji_ir_50e/best_stg2.pth`

Also available and used in the recent IR video inference:

`/home/starlab/Desktop/Kangnan/DJI/DEIMv2/outputs/deimv2_dinov3_s_dji_ir_50e/best_stg1.pth`

Config:

`/home/starlab/Desktop/Kangnan/DJI/DEIMv2/configs/deimv2/deimv2_dinov3_s_dji_ir_50e.yml`

Dataset:

`/home/starlab/Desktop/Kangnan/DJI/final_ir_640_yolo_coco_dataset`

Key settings:

- Model family: `DEIMv2-S`
- Backbone: DINOv3 STA small setup, `vit_tiny`
- Input size: `640x640`
- Classes: 10
- Category ids: zero-based COCO ids, `0..9`
- Epochs: 50
- Total batch size: 32
- Optimizer: AdamW
- Main learning rate: `0.0005`
- DINOv3 backbone learning rate: `0.000025`
- Weight decay: `0.0001`
- Warmup iterations: 300
- Scheduler: flat-cosine
- Flat epoch: 24
- No-augmentation final phase: last 5 epochs
- Main augmentations: Mosaic, RandomPhotometricDistort, RandomZoomOut, RandomIoUCrop, RandomHorizontalFlip, multi-scale resize
- Training output directory: `DEIMv2/outputs/deimv2_dinov3_s_dji_ir_50e`

IR dataset construction:

- Source images after dedup/filter: 859
- Source split: train 687, val 86, test 86
- Tile split: train 1374, val 172, test 172
- For `3840x2160`: two overlapping `2160x2160` horizontal crops at `x=0` and `x=1680`, resized to `640x640`
- For `1280x1024`: two overlapping `1024x1024` horizontal crops at `x=0` and `x=256`, resized to `640x640`

IR video inference setting:

- Input frame size: `1280x1024`
- Tile mode: two overlapping `1024x1024` crops
- Crop origins: `x=0` and `x=256`
- Each crop is resized to `640x640`
- Detections are mapped back to the original frame
- Overlap handling: class-aware NMS, plus suppression based on intersection over the smaller box area
- Recent full-video output: `runs/ir_video_inference/deimv2s_ir_tiled_org_043ae48d6ca58e3f_1784843382000.mp4`

## Current IR Benchmark Results

Held-out test metrics on `final_ir_640_yolo_coco_dataset`:

| Model | AP / mAP50-95 | AP50 / mAP50 | AP75 | Small AP | Medium AP | Large AP |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| YOLO26s | 0.526 | 0.853 | - | - | - | - |
| RT-DETRv4-S | 0.540 | 0.843 | 0.590 | 0.400 | 0.458 | 0.700 |
| DEIMv2-S | 0.565 | 0.863 | 0.597 | 0.410 | 0.481 | 0.689 |

## Other Current IR Weights

YOLO26s IR:

`/home/starlab/Desktop/Kangnan/DJI/YOLO26/runs/detect/yolo26s_dji_ir_100e_finetune/weights/best.pt`

RT-DETRv4-S IR:

`/home/starlab/Desktop/Kangnan/DJI/RT-DETRv4/outputs/rtv4_hgnetv2_s_dji_ir_50e/best_stg1.pth`
