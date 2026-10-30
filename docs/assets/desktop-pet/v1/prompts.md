# 生成提示词

工具：内置 imagegen；全部请求透明背景。原图仅用作角色参考。

## 正面立绘

```text
Use case: stylized-concept.
Asset type: master full-body character illustration for a desktop companion, to serve as the visual basis for later Live2D art preparation.
Input image: the attached character design sheet is a visual reference only. Recreate its SAME character, paying particular attention to the small standing front view at upper middle. Do not reproduce the sheet layout or any of its lettering.
Primary request: one beautifully finished large front-facing neutral standing full-body chibi cat girl, on actual transparent background. Cream ivory fluffy bobbed hair with soft peach shadows and long softly curled side locks, single curled cowlick, large triangular cat ears with blush-pink inner ears, huge powder-blue eyes with white highlights, tiny gentle closed smiling mouth and soft rosy cheeks. On viewer's right temple retain the little white smiling cloud hair clip and dusty-blue ribbon bow with tails and tiny blue barrette. Ivory roomy cape coat with dusty-blue trim and light-blue paw-print motifs on the lower sleeves and hem. A dusty-blue ribbon bow at throat. Two small arms relaxed slightly separated from body so the mitten-like hands and sleeves are individually readable. Two short cream legs and small rounded feet, both fully visible. One fluffy large cream cat tail curves out from BEHIND body on viewer's right, leaving the silhouette clear. Preserve the reference's exceptionally cute soft proportions, big head small body, delicate warm taupe linework, watercolor-like light pastel shading and restrained warm highlights.
Composition: orthographic straight front view, centered, complete character from ear tips to soles, no crop, generous transparent margin of about 10 percent. Pose calm and suitable for idle animation, eyes open looking forward, unobscured face, no held plush or props. Character should occupy most of a portrait canvas, high resolution and crisp enough for later cut-up.
Constraints: only ONE character and ONE tail, exactly two cat ears, two arms, two legs. No human ears, no additional animals, no separate cloud pet, no ground shadow, no backdrop, no checkerboard painted into the image, no lettering, no watermark, no labels, no panels, no sparkles. Genuine alpha transparency outside character. This is the full assembled master illustration, NOT an exploded diagram or a layered-file claim.
```

## 立绘留白修订

```text
Use case: precise-object-edit. Edit target: the attached single transparent full-body cat-girl master illustration. Make only a framing correction: keep the exact same character design, facial expression, colors, clothing, accessories, drawing style and pose. Place the WHOLE character including the curled cowlick, both ears, both feet, and entire tail comfortably inside the canvas with a clearly visible transparent margin on ALL FOUR sides, at least 7 percent of canvas size. Scale the complete character down to about 80 percent of canvas height. The highest cowlick must NOT touch the top and the farthest tail must NOT touch the right edge. Preserve actual alpha transparency and the delicate warm outline; eliminate stray detached paint specks around the silhouette. One complete character only, no text, no ground, no cast shadow, no panels, no new objects. Do not redesign her.
```

## 表情参考

```text
Use case: identity-preserve.
Asset type: desktop pet expression art reference sheet.
Input: the attached full-body master image is the STRICT character identity and rendering style reference.
Create a clean 3 columns by 2 rows contact sheet of exactly SIX large isolated HEAD portraits of this same chibi cat girl. Every head is straight front view with exactly identical head size, hair silhouette, curled cowlick, cream fur cat ears, cream-peach wavy hair, viewer-right cloud clip and dusty blue bow. Heads fully contained in their own grid cells with ample space, nothing touches. Include head and just throat bow; no body, no tail. Actual transparent background, no text labels, no panel lines, no decorative symbols outside heads.
Order left to right, top then bottom:
1 neutral gentle closed-mouth smile, two open blue eyes;
2 blink, both eyes softly closed, same tiny mouth;
3 joyful, eyes closed in happy upward curves, small happy open smile and blush;
4 surprised, wide blue eyes, small round open mouth;
5 sleepy, half-lidded blue eyes, tiny yawning mouth;
6 mildly sad/委屈, watery blue eyes, brows raised toward center, tiny downturned mouth, NO giant tears.
Keep exactly the same warm thin line art, soft pastel coloring, eye color and all design details of the master. This is an expression DESIGN reference, not an animation sprite sheet; visual consistency matters, but avoid any claim of pixel-aligned rig layers. No names, lettering, titles, background shapes or props.
```

## 尾巴补绘

```text
Use case: precise-object-edit. Asset type: one isolated redrawn tail part for later Live2D art assembly. Input reference is the attached full-body cat-girl master. Render ONLY her single fluffy cream cat tail, matching exactly its warm thin taupe linework, ivory fur, peach shadow colors, soft pastel fur texture and overall curved shape visible at the viewer's RIGHT of the master. Remove all character head, hair, body, clothing, feet and every other object. Reconstruct the complete tail including the formerly occluded narrow ROOT at its lower-left end, smoothly widening into the thick fluffy plume curling upward and to the right; all previously hidden edges must be drawn cleanly as real complete fur, not left erased or cut off. It should read as a single natural curled cat tail and retain the reference's shape, NOT a detached hair mass, a fox, or multiple tails. Straight front-view 2D painted part, shadow-free transparent canvas. Center entire tail with 12 percent transparent margin on all sides. Actual alpha transparency outside tail, NO ground shadow, NO backdrop, NO labels, NO text, NO grid. This is an independent art component draft for subsequent manual alignment, not a pixel-aligned PSD layer.
```
