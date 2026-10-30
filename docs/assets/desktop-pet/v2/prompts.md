# 生成提示词

工具：内置 imagegen。参考输入：首批原始竖直生成图；清理输入：本轮新生成图。两次均请求透明背景。

## 正立重绘

```text
Use case: precise-object-edit.
Asset type: upright front-facing full-body desktop companion illustration.
Edit target: the attached ORIGINAL UPRIGHT character master is the sole visual identity reference. Preserve her cream gold hair, powder blue gradient eyes, pink inner cat ears, curled cowlick, white cloud hair clip, dusty blue hair bow and neck bow, ivory cape with blue paw-print motifs, small hands, two short legs and boots, fluffy curled tail at viewer's right, delicate warm taupe line art and pale pastel shading.
Primary request: deliver a clean production-oriented static illustration in a TALL PORTRAIT canvas, preferably 1024 pixels wide by 1536 pixels tall. The character is STANDING UPRIGHT ON TWO FEET, straight frontal view. Her head, cowlick and ear tips are at the TOP of the image; the two feet and soles are at the BOTTOM, soles level and pointing down. Her body axis is VERTICAL aligned with the canvas Y axis. Both feet support her weight in a calm standing pose, knees straight, legs under the torso, no crossed legs. The face is level, looking straight forward with both blue eyes open and a tiny gentle smile.
Frame the complete character with at least 8 percent transparent empty space above cowlick, below soles, and beside tail and hair. One character, full silhouette contained in canvas.
Edge cleanup is essential: remove the red/yellow/white detached fringe and stray specks along the outside fur and hair silhouette. Keep cream fur opaque, deliberate soft edge antialiasing only at the contour. Preserve fine hair tips without colored halos.
Genuine fully transparent background, no backdrop or ground or cast shadow, no painted checkerboard, no text, no labels.
Avoid: landscape layout, rotated image, sideways body, lying down, sleeping pose, sitting, reclining, tilted pose, cropping, additional pets, additional tails, changed costume or character design. This is an assembled STATIC PNG art asset; do not depict separated parts.
```

## 透明与边缘清理

```text
Use case: background-extraction. Edit target: the attached new upright standing cat-girl illustration. Keep her exact pose and design. Deliver an actual clean TRANSPARENT cutout of the complete standing character. Remove ALL of the hazy beige, gray, brown and black background halo around her, including the empty region inside the curled cowlick. Empty background pixels outside her crisp drawn silhouette must have alpha ZERO, not semi-transparent haze or vignette. Keep the character's cream fur, hair, face and clothing fully opaque, including their interior white highlights. Remove colored fringe specks. Expand canvas framing so there is visible empty transparent margin around every part of her silhouette: at least 80px to left of hair, right of tail, above cowlick and below boots on a portrait canvas. Scale the character down within this new canvas, keeping entire figure visible. Her head stays at top, feet at bottom, vertically standing, no rotation. No new background, no cast shadow, no ground, no checkerboard, no glow or haze, no text, no other characters.
```
