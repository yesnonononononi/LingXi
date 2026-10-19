// 桌宠形象：纯 SVG 分层绘制（无位图素材）。坐标基于 220x280 的画布。
// 上色统一走 CSS 变量（见 palette.mjs），换配色不用改这里。
//
// 坐标基准（改造型前先看这里，别再瞎挪）：
//   头椭圆 cy=116 ry=62 → 头顶 54，下巴 178
//   刘海底边 ~100，眼睛 cy=124，嘴 cy=150
//   脖子 158~178，连衣裙 172~250，脚 cy=251

/** 画布尺寸，与 index.html 里 SVG 的 width/height 保持一致。 */
export const PET_VIEWBOX = Object.freeze({ width: 220, height: 280 });

/** 表情 group 的 id 前缀，渲染层靠它切脸。 */
export const FACE_GROUP_PREFIX = 'face-';

/** SVG 里必须存在的全部表情（测试据此断言没有漏画）。 */
export const FACES_IN_SVG = Object.freeze([
  'normal',
  'blink',
  'happy',
  'angry',
  'shy',
  'sleepy',
  'excited',
]);

const DEFS = `
  <defs>
    <clipPath id="petFaceClip">
      <ellipse cx="110" cy="116" rx="68" ry="62" />
    </clipPath>
  </defs>`;

// 尾巴：S 形向右侧上卷，端头带一点回勾。transform-origin 交给 CSS 做摆动。
const TAIL = `
  <g id="pet-tail">
    <path d="M150 238 C 190 250 218 222 208 190 C 201 166 178 158 166 172 C 159 181 163 192 173 193"
          fill="none" stroke="var(--pet-hair-shade)" stroke-width="17" stroke-linecap="round" />
    <path d="M150 238 C 190 250 218 222 208 190 C 201 166 178 158 166 172 C 159 181 163 192 173 193"
          fill="none" stroke="var(--pet-hair)" stroke-width="11" stroke-linecap="round" />
  </g>`;

// 后发：白色椭圆 + 细描边，在脸周围留一圈头发轮廓（不用灰填充，否则像戴头盔）
const HAIR_BACK = `
  <ellipse cx="110" cy="134" rx="72" ry="74" fill="var(--pet-hair)"
           stroke="var(--pet-hair-shade)" stroke-width="1.6" />`;

// 脚：先画，随后被裙摆盖住上半部分
const FEET = `
  <ellipse cx="94" cy="251" rx="14" ry="10" fill="var(--pet-skin)" />
  <ellipse cx="126" cy="251" rx="14" ry="10" fill="var(--pet-skin)" />`;

const NECK = `
  <rect x="100" y="156" width="20" height="22" rx="7" fill="var(--pet-skin)" />`;

// 连衣裙：肩窄裙摆宽的梯形，顶部圆弧领口
const DRESS = `
  <path d="M80 172 C 68 192 60 228 62 250 L158 250 C 160 228 152 192 140 172 Z"
        fill="var(--pet-cream)" />
  <path d="M92 173 Q110 187 128 173" fill="none"
        stroke="var(--pet-cream-shade)" stroke-width="3.2" stroke-linecap="round" />
  <path d="M62 250 C 88 244 132 244 158 250 Z" fill="var(--pet-cream-shade)" opacity="0.45" />`;

// 手臂：用粗圆头描边画，比椭圆更像胳膊
const ARMS = `
  <path d="M82 182 C 71 198 69 216 73 228" fill="none"
        stroke="var(--pet-skin)" stroke-width="15" stroke-linecap="round" />
  <path d="M138 182 C 149 198 151 216 147 228" fill="none"
        stroke="var(--pet-skin)" stroke-width="15" stroke-linecap="round" />`;

// 猫耳：先画耳、后画头，头自然盖住耳根
const EARS = `
  <path d="M62 88 L52 26 L116 72 Z" fill="var(--pet-hair)"
        stroke="var(--pet-hair)" stroke-width="11" stroke-linejoin="round" />
  <path d="M158 88 L168 26 L104 72 Z" fill="var(--pet-hair)"
        stroke="var(--pet-hair)" stroke-width="11" stroke-linejoin="round" />
  <path d="M71 79 L67 45 L101 71 Z" fill="var(--pet-blush)" />
  <path d="M149 79 L153 45 L119 71 Z" fill="var(--pet-blush)" />`;

const HEAD = `
  <ellipse cx="110" cy="116" rx="68" ry="62" fill="var(--pet-skin)" />`;

// 刘海：靠 clip 保证永不越出脸。底边抬到 y≈100，露出整张脸和眼睛
const BANGS = `
  <g clip-path="url(#petFaceClip)">
    <path d="M42 112 C 44 56 76 42 110 42 C 144 42 176 56 178 112
             C 170 96 158 88 146 92 C 143 82 132 77 122 84
             C 116 76 104 76 98 84 C 88 77 77 82 74 92
             C 62 88 50 96 42 112 Z"
          fill="var(--pet-hair)" />
    <path d="M42 112 C 44 56 76 42 110 42 C 144 42 176 56 178 112"
          fill="none" stroke="var(--pet-hair-shade)" stroke-width="1.6" opacity="0.7" />
  </g>`;

// 两侧长发，垂到肩下
const SIDE_HAIR = `
  <path d="M46 112 C 36 152 38 186 48 202 C 62 194 68 162 64 122 Z"
        fill="var(--pet-hair)" stroke="var(--pet-hair-shade)" stroke-width="1.4" />
  <path d="M174 112 C 184 152 182 186 172 202 C 158 194 152 162 156 122 Z"
        fill="var(--pet-hair)" stroke="var(--pet-hair-shade)" stroke-width="1.4" />`;

// 蝴蝶结：左侧头发上，两个三角 + 一个结 + 下半片阴影
const RIBBON = `
  <g id="pet-ribbon">
    <path d="M58 68 L28 50 C 25 66 26 84 33 93 L58 82 Z" fill="var(--pet-ribbon)" />
    <path d="M62 68 L90 50 C 93 66 92 84 85 93 L62 82 Z" fill="var(--pet-ribbon)" />
    <path d="M57 82 L32 93 C 42 100 55 100 64 96 Z"
          fill="var(--pet-ribbon-deep)" opacity="0.5" />
    <circle cx="60" cy="76" r="7" fill="var(--pet-ribbon-deep)" />
  </g>`;

// 呆毛：一根弯线，呆萌感全靠它
const AHOGE = `
  <path d="M118 46 C 124 26 138 23 146 33" fill="none"
        stroke="var(--pet-hair-shade)" stroke-width="5.5" stroke-linecap="round" />`;

// 公共元素：腮红、鼻子（所有表情共用，不随表情切换）
const COMMON_FACE = `
  <ellipse cx="66" cy="144" rx="12" ry="6.5" fill="var(--pet-blush)" opacity="0.85" />
  <ellipse cx="154" cy="144" rx="12" ry="6.5" fill="var(--pet-blush)" opacity="0.85" />
  <ellipse cx="110" cy="137" rx="2.2" ry="1.5" fill="var(--pet-skin-shade)" />`;

const EYE_OPEN = (cx) => `
  <ellipse cx="${cx}" cy="124" rx="13" ry="16" fill="var(--pet-eye)" />
  <ellipse cx="${cx - 4.5}" cy="117" rx="4.8" ry="6" fill="#FFFFFF" opacity="0.95" />
  <circle cx="${cx + 4}" cy="131" r="2.6" fill="#FFFFFF" opacity="0.7" />
  <path d="M${cx - 13} 111 Q${cx} 102 ${cx + 13} 111" fill="none"
        stroke="var(--pet-eye-deep)" stroke-width="3.2" stroke-linecap="round" />`;

const EYE_ARC_DOWN = (cx) => `
  <path d="M${cx - 11} 126 Q${cx} 134 ${cx + 11} 126" fill="none"
        stroke="var(--pet-eye-deep)" stroke-width="3.4" stroke-linecap="round" />`;

const EYE_ARC_UP = (cx) => `
  <path d="M${cx - 11} 126 Q${cx} 112 ${cx + 11} 126" fill="none"
        stroke="var(--pet-eye-deep)" stroke-width="3.6" stroke-linecap="round" />`;

const MOUTH_SMALL = `
  <path d="M105 147 Q110 152 115 147" fill="none"
        stroke="var(--pet-ink)" stroke-width="2.4" stroke-linecap="round" />`;

const MOUTH_OPEN = `
  <path d="M102 144 Q110 158 118 144 Z" fill="#E89090" />`;

const MOUTH_WRY = `
  <path d="M102 153 Q110 145 118 153" fill="none"
        stroke="var(--pet-ink)" stroke-width="2.6" stroke-linecap="round" />`;

/** 每个表情是一组「眉毛 + 眼 + 嘴 + 附加物」。 */
const FACE_LAYERS = {
  normal: `${EYE_OPEN(86)}${EYE_OPEN(134)}${MOUTH_SMALL}`,

  blink: `${EYE_ARC_DOWN(86)}${EYE_ARC_DOWN(134)}${MOUTH_SMALL}`,

  happy: `${EYE_ARC_UP(86)}${EYE_ARC_UP(134)}${MOUTH_OPEN}`,

  angry: `
    <path d="M73 108 L99 115" fill="none" stroke="var(--pet-ink)" stroke-width="3" stroke-linecap="round" />
    <path d="M147 108 L121 115" fill="none" stroke="var(--pet-ink)" stroke-width="3" stroke-linecap="round" />
    <ellipse cx="86" cy="127" rx="11.5" ry="11.5" fill="var(--pet-eye)" />
    <ellipse cx="134" cy="127" rx="11.5" ry="11.5" fill="var(--pet-eye)" />
    <circle cx="86" cy="127" r="4" fill="#FFFFFF" opacity="0.85" />
    <circle cx="134" cy="127" r="4" fill="#FFFFFF" opacity="0.85" />
    ${MOUTH_WRY}
    <path d="M160 76 h9 l-9 9 h9" fill="none" stroke="#D08B7B" stroke-width="2.2" stroke-linecap="round" />`,

  shy: `
    ${EYE_ARC_UP(86)}${EYE_ARC_UP(134)}
    <ellipse cx="66" cy="146" rx="16" ry="9" fill="var(--pet-blush)" />
    <ellipse cx="154" cy="146" rx="16" ry="9" fill="var(--pet-blush)" />
    ${MOUTH_SMALL}`,

  sleepy: `
    ${EYE_ARC_DOWN(86)}${EYE_ARC_DOWN(134)}
    <path d="M104 149 Q110 153 116 149" fill="none"
          stroke="var(--pet-ink)" stroke-width="2.4" stroke-linecap="round" />
    <path d="M162 80 h10 l-10 10 h10" fill="none" stroke="#B39A8A" stroke-width="2.4" stroke-linecap="round" />
    <path d="M176 62 h7 l-7 7 h7" fill="none" stroke="#C7B2A4" stroke-width="2" stroke-linecap="round" />`,

  excited: `
    <ellipse cx="86" cy="122" rx="14.5" ry="17.5" fill="var(--pet-eye)" />
    <ellipse cx="134" cy="122" rx="14.5" ry="17.5" fill="var(--pet-eye)" />
    <ellipse cx="81" cy="115" rx="5.2" ry="6.2" fill="#FFFFFF" opacity="0.95" />
    <ellipse cx="129" cy="115" rx="5.2" ry="6.2" fill="#FFFFFF" opacity="0.95" />
    <circle cx="92" cy="130" r="3.2" fill="#FFFFFF" opacity="0.75" />
    <circle cx="140" cy="130" r="3.2" fill="#FFFFFF" opacity="0.75" />
    ${MOUTH_OPEN}
    <path d="M108 100 L110.5 105 L116 107 L110.5 109 L108 114 L105.5 109 L100 107 L105.5 105 Z"
          fill="#FFD98A" opacity="0.95" />`,
};

function buildFaceGroup(face) {
  return `<g id="${FACE_GROUP_PREFIX}${face}" class="pet-face">${FACE_LAYERS[face]}</g>`;
}

/**
 * 生成完整宠物 SVG。
 * @returns {string} SVG 源码字符串（不含外层容器属性）
 */
export function buildPetSvg() {
  const faces = FACES_IN_SVG.map(buildFaceGroup).join('');
  return [
    `<svg id="pet-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PET_VIEWBOX.width} ${PET_VIEWBOX.height}"`,
    ` data-face="normal" data-action="idle" aria-hidden="true">`,
    DEFS,
    '<g id="pet-body-root">',
    TAIL,
    HAIR_BACK,
    SIDE_HAIR,
    FEET,
    NECK,
    DRESS,
    ARMS,
    EARS,
    HEAD,
    BANGS,
    COMMON_FACE,
    faces,
    RIBBON,
    AHOGE,
    '</g>',
    '</svg>',
  ].join('');
}
