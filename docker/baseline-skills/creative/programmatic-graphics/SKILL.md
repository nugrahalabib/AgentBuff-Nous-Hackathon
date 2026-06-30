---
name: programmatic-graphics
description: "Programmatic image generation & drawing (Python/Pillow, Turtle, SVG)."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [creative, drawing, pillow, python, graphics, generative, svg, diagrams]
    category: creative
---

# Programmatic Graphics

Use this skill to generate images, diagrams, patterns, and icons using code (primarily Python/Pillow) when high-level generative AI tools (like ComfyUI or DALL-E) are unavailable, unconfigured, or when the task requires precise, deterministic geometry.

## When to Use

- **Fallback**: High-level image generation tools (e.g., `image_generate`, ComfyUI) are not installed or fail to run.
- **Precision**: User needs specific shapes, exact dimensions, or code-defined patterns (e.g., "a grid of 10x10 blue squares").
- **Diagrams/Charts**: Simple visualizations where Matplotlib or pure PIL drawing is more efficient than a full design tool.
- **Dynamic Icons**: Generating variations of a base icon (e.g., different colors/sizes).

## Stack

### Python (Pillow) - Recommended
Best for general raster images (.png, .jpg).
- **Install**: `pip install Pillow --user`
- **Pattern**: Create `Image`, get `ImageDraw`, use methods like `ellipse`, `rectangle`, `polygon`, `line`, `text`.

### SVG (XML)
Best for vector graphics, icons, and diagrams that need to be crisp at any scale.
- **Pattern**: Write raw XML `<svg>...</svg>` to a `.svg` file.

### Python (Turtle)
Best for educational graphics, fractals, and path-based drawings.
- **Note**: Requires a display or a headless virtual frame buffer (like `xvfb`). Use only if X11/display is available or simple patterns are needed.

## Triggers & Autonomous Fallback

If you or a subagent (via `delegate_task`) are tasked with "generating an image" and hit any of the following, switch to this skill:
- **Subagent Tool Failure**: A subagent tries to use `image_gen` (e.g., via `bash_run`) and fails because the tool is missing or unconfigured. The subagent should pivot to writing a Pillow script to fulfill the user's request.
- **Missing Tool**: You see `image_gen` is enabled in `hermes tools list`, but calling it returns `Tool 'image_gen' does not exist` (usually means no provider like FAL/OpenAI is configured in `.env`).
- **Environment Constraints**: You are in a restricted environment (like some CI/CD runners) where network access to external image APIs is blocked, but Python/Pillow is available.

## Workflow (Refined)

1.  **Requirement Check**: Define the subject, dimensions, and color palette.
2.  **Tool Selection**: Choose Pillow for raster or SVG for vector.
3.  **Environment Check**: Verify dependencies (e.g., `python3 -c "import PIL"`).
4.  **Drafting**: Write a script that defines the drawing logic.
    -   Use primitive shapes to build complexity (e.g., ellipses for bodies, triangles for beaks).
    -   Keep coordinates relative to canvas size for easier scaling.
5.  **Execution & Verification**: Run the script and use `vision_analyze` to confirm the output matches the intent. If it looks like a "primitive cluster" rather than the subject, add labels or more detail.
6.  **Delivery**: Return the absolute file path and the `MEDIA:/path` tag. Describe it as a "Programmatic Drawing" to manage user expectations vs. AI-generated art.

## Pitfalls

-   **Coordinates**: PIL uses `(0,0)` at the top-left.
-   **Colors**: Use standard names ('red', 'blue') or Hex/RGB tuples.
-   **Display Requirements**: Some Python libraries (like Turtle or Matplotlib's default backend) try to open a window. Always use non-interactive backends (e.g., `matplotlib.use('Agg')`) or pure drawing libraries like Pillow.
-   **Font Loading**: PIL's `ImageFont.truetype()` requires a path to a `.ttf` file. Stick to default fonts or basic shapes if font paths are unknown.

## Examples

### Simple Pillow Drawing (Chicken Pattern)
```python
from PIL import Image, ImageDraw
img = Image.new('RGB', (400, 400), 'white')
draw = ImageDraw.Draw(img)
# Body
draw.ellipse([100, 150, 300, 300], fill='yellow', outline='black')
# Head
draw.ellipse([220, 80, 320, 180], fill='yellow', outline='black')
# Beak
draw.polygon([(320, 130), (350, 140), (320, 150)], fill='orange', outline='black')
img.save('chicken.png')
```
