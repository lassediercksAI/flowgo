/*!
 * remark-flowgo client bundle -- GENERATED, do not edit by hand.
 * Regenerate with: pnpm run build:vendor (from remark-flowgo/), or
 * pnpm run build (which also does this as part of a full build).
 *
 * Two parts concatenated in order:
 *   1. the vendored flowgo-inline.js IIFE (defines window.FlowgoInline;
 *      built from ../src/render/inline.ts at the repo root)
 *   2. this package's hydration bootstrap (src/browser-entry.ts)
 */
var FlowgoInline=(function(e){Object.defineProperty(e,Symbol.toStringTag,{value:`Module`});var t=e=>typeof e==`number`&&Number.isInteger(e)&&e>=2&&e<=9?e:1,n=e=>t(e),r=e=>Math.round(e*100)/100,i=e=>{if(e.length<2)return``;let t=e[0];if(e.length===2){let n=e[1];return`M${r(t[0])},${r(t[1])} L${r(n[0])},${r(n[1])}`}let n=`M${r(t[0])},${r(t[1])}`;for(let t=1;t<e.length-1;t++){let i=e[t],a=e[t+1],o=(i[0]+a[0])/2,s=(i[1]+a[1])/2;n+=` Q${r(i[0])},${r(i[1])} ${r(o)},${r(s)}`}let i=e[e.length-1];return n+=` L${r(i[0])},${r(i[1])}`,n},a=[`t`,`r`,`b`,`l`,`tl`,`tr`,`bl`,`br`],o=e=>e===`t`||e===`r`||e===`b`||e===`l`||e===`tl`||e===`tr`||e===`bl`||e===`br`,s=.25,c=(e,t,n)=>{if(n===2)return l(e,t);if(n===3)return u(e,t);let r=e.x+e.width/2,i=e.y+e.height/2,a=n===1,o=e.y+3,c=e.y+e.height-3,d=(a?e.x+e.width*s:e.x)+3,f=(a?e.x+e.width*(1-s):e.x+e.width)-3;switch(t){case`t`:return[r,o];case`b`:return[r,c];case`l`:return[e.x+3,i];case`r`:return[e.x+e.width-3,i];case`tl`:return[d,o];case`tr`:return[f,o];case`bl`:return[d,c];case`br`:return[f,c]}},l=(e,t)=>{let n=e.x+e.width/2,r=e.y+e.height/2,i=Math.min(e.width,e.height)/2-3,a=i/Math.SQRT2;switch(t){case`t`:return[n,r-i];case`b`:return[n,r+i];case`l`:return[n-i,r];case`r`:return[n+i,r];case`tl`:return[n-a,r-a];case`tr`:return[n+a,r-a];case`bl`:return[n-a,r+a];case`br`:return[n+a,r+a]}},u=(e,t)=>{let n=e.x+e.width/2,r=e.width,i=e.height,a=(()=>{switch(t){case`t`:return[n,e.y];case`tl`:return[n-r/4,e.y+i/2];case`tr`:return[n+r/4,e.y+i/2];case`l`:return[n-3*r/8,e.y+3*i/4];case`r`:return[n+3*r/8,e.y+3*i/4];case`b`:return[n,e.y+i];case`bl`:return[e.x,e.y+i];case`br`:return[e.x+r,e.y+i]}})(),o=n,s=e.y+2*i/3,c=o-a[0],l=s-a[1],u=Math.hypot(c,l);return u===0?a:[a[0]+c/u*3,a[1]+l/u*3]},d=(e,t,n)=>{let r=`r`,i=1/0;for(let o of a){let[a,s]=c(e,o,n),l=Math.hypot(a-t[0],s-t[1]);l<i&&(i=l,r=o)}return r},f=(e,t,n,r)=>c(e,t&&o(t)?t:d(e,n,r),r),p=(e,t)=>e===`/`?`/${t}`:`${e}/${t}`,m=e=>(e.boxes?.length??0)>0||(e.edges?.length??0)>0||(e.texts?.length??0)>0||(e.lines?.length??0)>0||(e.strokes?.length??0)>0,h=(e,t,n)=>{let r=p(t,n),i=r+`/`;for(let t of e.maps??[])if(!(t.path!==r&&!t.path.startsWith(i))&&m(t))return!0;return!1},g=class extends Error{},_=e=>{let t=[],n=``,r=!1,i=!1,a=!1,o=()=>{(n.length>0||a)&&(t.push(n),n=``,a=!1)};for(let t of e)i?(n+=t===`n`?`
`:t,i=!1):t===`\\`?i=!0:t===`"`?(r=!r,a=!0):!r&&(t===` `||t===`	`)?o():n+=t;return o(),t},v=e=>{let t=e.indexOf(`:`);return t>=0?[e.slice(0,t),e.slice(t+1)]:[e,``]},y=(e,t,n)=>{let r=Number(e);if(!Number.isFinite(r)||e.trim()===``)throw new g(`line ${t}: bad ${n}: ${JSON.stringify(e)}`);return r},b=(e,t,n)=>{if(!/^-?\d+$/.test(e))throw new g(`line ${t}: bad ${n}: ${JSON.stringify(e)}`);return parseInt(e,10)},x=e=>{let t=[],n=e=>{let n=t.find(t=>t.path===e);return n||(n={path:e,boxes:[],edges:[],texts:[],lines:[],strokes:[],images:[]},t.push(n)),n},r=n(`/`),i,a=0,o=e.split(/\r\n|\r|\n/);for(let e=1;e<=o.length;e++){let t=o[e-1].trim();if(t===``||t.startsWith(`#`))continue;let s=_(t);if(s.length===0||s[0]===``)continue;let c=s[0];switch(c){case`version`:if(s.length<2)throw new g(`line ${e}: version needs a value`);i=s[1];break;case`hexagons`:if(s.length<2){a===0&&(a=1);break}if(s[1]===`on`||s[1]===`1`||s[1]===`true`)a===0&&(a=1);else if(!(s[1]===`off`||s[1]===`0`||s[1]===`false`))throw new g(`line ${e}: hexagons wants on or off, got ${JSON.stringify(s[1])}`);break;case`defaultshape`:{if(s.length<2)throw new g(`line ${e}: defaultshape needs a value`);let t=b(s[1],e,`defaultshape`);t>=1&&t<=9&&(a=t);break}case`map`:if(s.length<2)throw new g(`line ${e}: map needs path`);r=n(s[1]);break;case`node`:case`box`:{if(s.length<5)throw new g(`line ${e}: ${c} needs id label x y`);let t=y(s[3],e,`x`),n=y(s[4],e,`y`),i={id:s[1],label:s[2],x:t,y:n};if(s.length>=6&&b(s[5],e,`sides`),s.length>=7){let t=b(s[6],e,`palette`);t>=2&&t<=9&&(i.palette=t)}if(s.length>=8){let t=b(s[7],e,`font`);t>=2&&t<=9&&(i.font=t)}s.length>=9&&b(s[8],e,`rotation`),r.boxes.push(i);break}case`edge`:{if(s.length<3)throw new g(`line ${e}: edge needs from to`);let[t,n]=v(s[1]),[i,a]=v(s[2]),o={from:t,to:i};if(n&&(o.fromHandle=n),a&&(o.toHandle=a),s.length>=4){let t=b(s[3],e,`edge palette`);t>=2&&t<=9&&(o.palette=t)}let c=s[4];c!==void 0&&c!==``&&(o.label=c),r.edges.push(o);break}case`text`:{if(s.length<5)throw new g(`line ${e}: text needs id label x y`);let t=y(s[3],e,`x`),n=y(s[4],e,`y`),i={id:s[1],label:s[2],x:t,y:n};if(s.length>=6){let t=b(s[5],e,`text palette`);t>=2&&t<=9&&(i.palette=t)}if(s.length>=7){let t=b(s[6],e,`text font`);t>=2&&t<=9&&(i.font=t)}r.texts.push(i);break}case`line`:{if(s.length<6)throw new g(`line ${e}: line needs id x1 y1 x2 y2`);let t=y(s[2],e,`coord`),n=y(s[3],e,`coord`),i=y(s[4],e,`coord`),a=y(s[5],e,`coord`),o={id:s[1],x1:t,y1:n,x2:i,y2:a};if(s.length>=7){let t=b(s[6],e,`line palette`);t>=2&&t<=9&&(o.palette=t)}if(s.length>7){if((s.length-7)%2!=0)throw new g(`line ${e}: line mids need pairs of coords`);let t=[];for(let n=7;n<s.length;n+=2)t.push([y(s[n],e,`line mid x`),y(s[n+1],e,`line mid y`)]);o.mids=t}r.lines.push(o);break}case`linestyle`:{if(s.length<3)throw new g(`line ${e}: linestyle needs id and style`);let t=b(s[2],e,`linestyle`);if(t<2||t>9)break;let n=r.lines.find(e=>e.id===s[1]);if(!n)throw new g(`line ${e}: linestyle refers to unknown line ${JSON.stringify(s[1])}`);n.style=t;break}case`nodesize`:case`boxsize`:{if(s.length<4)throw new g(`line ${e}: ${c} needs id, width, and height`);let t=y(s[2],e,`${c} width`),n=y(s[3],e,`${c} height`);if(t<=0||n<=0)break;let i=r.boxes.find(e=>e.id===s[1]);if(!i)throw new g(`line ${e}: ${c} refers to unknown node ${JSON.stringify(s[1])}`);i.w=t,i.h=n;break}case`nodeshape`:case`boxshape`:{if(s.length<3)throw new g(`line ${e}: ${c} needs id and shape`);let t=b(s[2],e,c);if(t<1||t>9)break;let n=r.boxes.find(e=>e.id===s[1]);if(!n)throw new g(`line ${e}: ${c} refers to unknown node ${JSON.stringify(s[1])}`);n.shape=t;break}case`anchor`:{if(s.length<2)throw new g(`line ${e}: anchor needs id`);let t=s[1],n=!1;for(let e of r.boxes)e.id===t?(e.anchor=!0,n=!0):e.anchor=!1;if(!n)throw new g(`line ${e}: anchor refers to unknown node ${JSON.stringify(t)}`);break}case`stroke`:{if(s.length<4)throw new g(`line ${e}: stroke needs id and at least two points`);let t=2,n=0;if(!s[2].includes(`,`)&&(n=b(s[2],e,`stroke palette`),t=3,s.length<5))throw new g(`line ${e}: stroke needs at least two points`);let i=[];for(let n=t;n<s.length;n++){let t=s[n].split(`,`);if(t.length!==2)throw new g(`line ${e}: bad stroke point ${JSON.stringify(s[n])}`);i.push([y(t[0],e,`stroke x`),y(t[1],e,`stroke y`)])}let a={id:s[1],points:i};n>=2&&n<=9&&(a.palette=n),r.strokes.push(a);break}case`image`:if(s.length<7)throw new g(`line ${e}: image needs id src x y width height`);r.images.push({id:s[1],src:s[2],x:y(s[3],e,`image coord`),y:y(s[4],e,`image coord`),width:y(s[5],e,`image coord`),height:y(s[6],e,`image coord`)});break;default:throw new g(`line ${e}: unknown directive ${JSON.stringify(c)}`)}}let s={maps:t};return i&&(s.version=i),a>=1&&a<=9&&(s.defaultShape=a),s},S=e=>{switch(e){case 1:return{w:240,h:208};case 2:return{w:208,h:208};case 3:return{w:240,h:208};default:return null}},C=`http://www.w3.org/2000/svg`,w=`flowgo-inline-style`,T=`
.fgi-root { position: relative; overflow: hidden; width: 100%; height: 100%; min-height: 200px; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; box-sizing: border-box; }
.fgi-root, .fgi-root * { box-sizing: border-box; }
.fgi-crumbs { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; gap: 4px; padding: 6px 8px; font-size: 12px; color: #444; background: rgba(255,255,255,.85); border-bottom: 1px solid #e5e5e5; overflow-x: auto; white-space: nowrap; }
.fgi-crumbs button { border: none; background: none; padding: 2px 4px; font: inherit; color: #37f; cursor: pointer; border-radius: 3px; }
.fgi-crumbs button:hover { background: #eef; }
.fgi-crumbs span.fgi-crumb-sep { color: #bbb; }
.fgi-crumbs span.fgi-crumb-cur { padding: 2px 4px; color: #444; }
.fgi-viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
.fgi-viewport.fgi-panning { cursor: grabbing; }
.fgi-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.fgi-svg { position: absolute; left: 0; top: 0; overflow: visible; width: 1px; height: 1px; z-index: 1; }
.fgi-layer { position: absolute; left: 0; top: 0; z-index: 2; }
.fgi-box { position: absolute; isolation: isolate; min-width: 80px; padding: 0.55em 0.85em; background: #fff; color: #333; border: 2px solid #333; border-radius: 6px; font-size: 14px; line-height: 1.25; text-align: center; white-space: pre-wrap; word-break: break-word; }
.fgi-box.fgi-has-submap { cursor: pointer; box-shadow: 4px 4px 0 0 #222; }
.fgi-box.fgi-sized { display: flex; align-items: center; justify-content: center; overflow: hidden; }
.fgi-box.fgi-hex { border: none; background: transparent; box-shadow: none; }
.fgi-box.fgi-hex::before, .fgi-box.fgi-hex::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
.fgi-box.fgi-hex::before { clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%); background: #333; z-index: -2; }
.fgi-box.fgi-hex::after { clip-path: polygon(25.48% 0.97%, 74.52% 0.97%, 99.01% 50%, 74.52% 99.03%, 25.48% 99.03%, 0.99% 50%); background: #fff; z-index: -1; }
.fgi-box.fgi-circle { border-radius: 50%; }
.fgi-box.fgi-tri { border: none; background: transparent; box-shadow: none; padding-top: 1.6em; }
.fgi-box.fgi-tri::before, .fgi-box.fgi-tri::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
.fgi-box.fgi-tri::before { clip-path: polygon(50% 0%, 100% 100%, 0% 100%); background: #333; z-index: -2; }
.fgi-box.fgi-tri::after { clip-path: polygon(50% 2.88%, 97.84% 98.56%, 2.16% 98.56%); background: #fff; z-index: -1; }
.fgi-box.fgi-palette-2 { background: #bfdbfe; border-color: #1d4ed8; color: #1e3a8a; }
.fgi-box.fgi-palette-3 { background: #ddd6fe; border-color: #6d28d9; color: #4c1d95; }
.fgi-box.fgi-palette-4 { background: #bbf7d0; border-color: #15803d; color: #14532d; }
.fgi-box.fgi-palette-5 { background: #fef9c3; border-color: #a16207; color: #713f12; }
.fgi-box.fgi-palette-6 { background: #fecaca; border-color: #b91c1c; color: #7f1d1d; }
.fgi-box.fgi-palette-7 { background: #fed7aa; border-color: #c2410c; color: #7c2d12; }
.fgi-box.fgi-palette-8 { background: #e5e7eb; border-color: #374151; color: #111827; }
.fgi-box.fgi-palette-9 { background: #111; border-color: #fff; color: #fff; }
.fgi-box.fgi-font-2 { font-size: 16px; } .fgi-box.fgi-font-3 { font-size: 18px; } .fgi-box.fgi-font-4 { font-size: 20px; }
.fgi-box.fgi-font-5 { font-size: 24px; } .fgi-box.fgi-font-6 { font-size: 28px; } .fgi-box.fgi-font-7 { font-size: 34px; }
.fgi-box.fgi-font-8 { font-size: 42px; } .fgi-box.fgi-font-9 { font-size: 56px; }
.fgi-text { position: absolute; font-size: 14px; color: #333; white-space: pre-wrap; pointer-events: none; }
.fgi-text.fgi-palette-2 { color: #1d4ed8; } .fgi-text.fgi-palette-3 { color: #6d28d9; } .fgi-text.fgi-palette-4 { color: #15803d; }
.fgi-text.fgi-palette-5 { color: #a16207; } .fgi-text.fgi-palette-6 { color: #b91c1c; } .fgi-text.fgi-palette-7 { color: #c2410c; }
.fgi-text.fgi-palette-8 { color: #374151; } .fgi-text.fgi-palette-9 { color: #000; }
.fgi-text.fgi-font-2 { font-size: 16px; } .fgi-text.fgi-font-3 { font-size: 18px; } .fgi-text.fgi-font-4 { font-size: 20px; }
.fgi-text.fgi-font-5 { font-size: 24px; } .fgi-text.fgi-font-6 { font-size: 28px; } .fgi-text.fgi-font-7 { font-size: 34px; }
.fgi-text.fgi-font-8 { font-size: 42px; } .fgi-text.fgi-font-9 { font-size: 56px; }
.fgi-edge-label {
  position: absolute; transform: translate(-50%, -50%); pointer-events: none;
  max-width: 220px; padding: 1px 5px; border-radius: 4px;
  background: rgba(255,255,255,.92); color: #444;
  font-size: 12px; line-height: 1.25; text-align: center;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.fgi-image { position: absolute; pointer-events: none; }
.fgi-image img { width: 100%; height: 100%; object-fit: contain; display: block; }
.fgi-edge-line, .fgi-line-line { stroke: #333; stroke-width: 2; fill: none; }
.fgi-stroke-line { stroke: #333; stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.fgi-palette-2 .fgi-edge-line, .fgi-palette-2 .fgi-line-line, .fgi-palette-2 .fgi-stroke-line { stroke: #1d4ed8; }
.fgi-palette-3 .fgi-edge-line, .fgi-palette-3 .fgi-line-line, .fgi-palette-3 .fgi-stroke-line { stroke: #6d28d9; }
.fgi-palette-4 .fgi-edge-line, .fgi-palette-4 .fgi-line-line, .fgi-palette-4 .fgi-stroke-line { stroke: #15803d; }
.fgi-palette-5 .fgi-edge-line, .fgi-palette-5 .fgi-line-line, .fgi-palette-5 .fgi-stroke-line { stroke: #a16207; }
.fgi-palette-6 .fgi-edge-line, .fgi-palette-6 .fgi-line-line, .fgi-palette-6 .fgi-stroke-line { stroke: #b91c1c; }
.fgi-palette-7 .fgi-edge-line, .fgi-palette-7 .fgi-line-line, .fgi-palette-7 .fgi-stroke-line { stroke: #c2410c; }
.fgi-palette-8 .fgi-edge-line, .fgi-palette-8 .fgi-line-line, .fgi-palette-8 .fgi-stroke-line { stroke: #374151; }
.fgi-palette-9 .fgi-edge-line, .fgi-palette-9 .fgi-line-line, .fgi-palette-9 .fgi-stroke-line { stroke: #000; }
`,E=()=>{if(document.getElementById(w))return;let e=document.createElement(`style`);e.id=w,e.textContent=T,document.head.appendChild(e)},D=(e,t)=>!t||/^(https?:)?\/\/|^data:/.test(e)?e:t.replace(/\/$/,``)+`/`+e.replace(/^\//,``),O=e=>({path:e,boxes:[],edges:[],texts:[],lines:[],strokes:[],images:[]}),k=(e,r,a={})=>{E();let o=x(r),s=a.pan??!0,c=a.zoom??!0,l=a.drillIn??!0,u=a.mediaBaseUrl,d=a.path??`/`,m=0,g=0,_=1;e.innerHTML=``;let v=document.createElement(`div`);v.className=`fgi-root`;let y=document.createElement(`div`);y.className=`fgi-crumbs`;let b=document.createElement(`div`);b.className=`fgi-viewport`;let w=document.createElement(`div`);w.className=`fgi-world`;let T=document.createElementNS(C,`svg`);T.setAttribute(`class`,`fgi-svg`);let k=document.createElementNS(C,`g`),j=document.createElementNS(C,`g`),M=document.createElementNS(C,`g`);T.append(k,j,M);let N=document.createElement(`div`);N.className=`fgi-layer`,w.append(T,N),b.appendChild(w),v.appendChild(b),l&&v.appendChild(y),e.appendChild(v);let P=()=>{w.style.transform=`translate(${m}px, ${g}px) scale(${_})`},F=e=>o.maps?.find(t=>t.path===e)??O(e),I=()=>{if(!l)return;y.innerHTML=``;let e=d===`/`?[]:d.split(`/`).filter(Boolean),t=(e,t,n)=>{if(n){let t=document.createElement(`span`);t.className=`fgi-crumb-cur`,t.textContent=e,y.appendChild(t)}else{let n=document.createElement(`button`);n.type=`button`,n.textContent=e,n.addEventListener(`click`,()=>R.goTo(t)),y.appendChild(n);let r=document.createElement(`span`);r.className=`fgi-crumb-sep`,r.textContent=`/`,y.appendChild(r)}};t(`/`,`/`,e.length===0);let n=``;e.forEach((r,i)=>{n+=`/`+r,t(r,n,i===e.length-1)})},L=()=>{N.innerHTML=``,k.innerHTML=``,j.innerHTML=``,M.innerHTML=``;let e=F(d),r=new Map;for(let i of e.boxes??[]){let e=document.createElement(`div`),a=t(i.palette),s=n(i.font),c=l&&h(o,d,i.id);e.className=`fgi-box`+(i.shape===1?` fgi-hex`:i.shape===2?` fgi-circle`:i.shape===3?` fgi-tri`:``)+(c?` fgi-has-submap`:``)+(a===1?``:` fgi-palette-`+a)+(s===1?``:` fgi-font-`+s),e.style.left=i.x+`px`,e.style.top=i.y+`px`;let u=S(i.shape);u?(e.style.width=u.w+`px`,e.style.height=u.h+`px`,e.classList.add(`fgi-sized`)):i.w&&i.h&&(e.style.width=i.w+`px`,e.style.height=i.h+`px`,e.classList.add(`fgi-sized`)),e.textContent=i.label,c&&(e.title=`Click to open submap`,e.addEventListener(`click`,e=>{e.stopPropagation(),R.goTo(p(d,i.id))})),N.appendChild(e),r.set(i.id,e)}for(let r of e.texts??[]){let e=document.createElement(`div`),i=t(r.palette),a=n(r.font);e.className=`fgi-text`+(i===1?``:` fgi-palette-`+i)+(a===1?``:` fgi-font-`+a),e.style.left=r.x+`px`,e.style.top=r.y+`px`,e.textContent=r.label,N.appendChild(e)}for(let t of e.images??[]){let e=document.createElement(`div`);e.className=`fgi-image`,e.style.left=t.x+`px`,e.style.top=t.y+`px`,e.style.width=t.width+`px`,e.style.height=t.height+`px`;let n=document.createElement(`img`);n.src=D(t.src,u),n.alt=``,e.appendChild(n),N.appendChild(e)}for(let n of e.strokes??[]){if(!n.points||n.points.length<2)continue;let e=t(n.palette),r=document.createElementNS(C,`g`);r.setAttribute(`class`,`fgi-stroke-group`+(e===1?``:` fgi-palette-`+e));let a=document.createElementNS(C,`path`);a.setAttribute(`class`,`fgi-stroke-line`),a.setAttribute(`d`,i(n.points)),r.appendChild(a),k.appendChild(r)}for(let n of e.lines??[]){let e=t(n.palette),r=document.createElementNS(C,`g`);r.setAttribute(`class`,`fgi-line-group`+(e===1?``:` fgi-palette-`+e));let i=document.createElementNS(C,`path`);i.setAttribute(`class`,`fgi-line-line`),i.setAttribute(`d`,A(n)),r.appendChild(i),j.appendChild(r)}for(let n of e.edges??[]){let i=(e.boxes??[]).find(e=>e.id===n.from),a=(e.boxes??[]).find(e=>e.id===n.to),o=i&&r.get(i.id),s=a&&r.get(a.id);if(!i||!a||!o||!s)continue;let c={x:i.x,y:i.y,width:o.offsetWidth,height:o.offsetHeight},l={x:a.x,y:a.y,width:s.offsetWidth,height:s.offsetHeight},u=l.x+l.width/2,d=l.y+l.height/2,p=c.x+c.width/2,m=c.y+c.height/2,[h,g]=f(c,n.fromHandle,[u,d],i.shape),[_,v]=f(l,n.toHandle,[p,m],a.shape),y=t(n.palette),b=document.createElementNS(C,`g`);b.setAttribute(`class`,`fgi-edge-group`+(y===1?``:` fgi-palette-`+y));let x=document.createElementNS(C,`line`);x.setAttribute(`class`,`fgi-edge-line`),x.setAttribute(`x1`,String(h)),x.setAttribute(`y1`,String(g)),x.setAttribute(`x2`,String(_)),x.setAttribute(`y2`,String(v)),b.appendChild(x),M.appendChild(b);let S=n.label??``;if(S!==``){let e=document.createElement(`div`);e.className=`fgi-edge-label`,e.style.left=(h+_)/2+`px`,e.style.top=(g+v)/2+`px`,e.textContent=S,N.appendChild(e)}}I()};if(s){let e=!1,t=0,n=0,r=0,i=0;b.addEventListener(`pointerdown`,a=>{a.target.closest(`.fgi-box, .fgi-has-submap`)||(e=!0,b.classList.add(`fgi-panning`),b.setPointerCapture(a.pointerId),t=a.clientX,n=a.clientY,r=m,i=g)}),b.addEventListener(`pointermove`,a=>{e&&(m=r+(a.clientX-t),g=i+(a.clientY-n),P())});let a=()=>{e=!1,b.classList.remove(`fgi-panning`)};b.addEventListener(`pointerup`,a),b.addEventListener(`pointercancel`,a)}c&&b.addEventListener(`wheel`,e=>{e.preventDefault();let t=b.getBoundingClientRect(),n=e.clientX-t.left,r=e.clientY-t.top,i=(n-m)/_,a=(r-g)/_,o=Math.exp(-e.deltaY*.001),s=Math.min(3,Math.max(.2,_*o));m=n-i*s,g=r-a*s,_=s,P()},{passive:!1});let R={get path(){return d},goTo(e){d=e,L()},destroy(){e.innerHTML=``}};return P(),L(),R},A=e=>{let t=e.mids??[],n=[[e.x1,e.y1],...t,[e.x2,e.y2]],r=e.style??1;if(r===2&&t.length>0){let n=`M ${e.x1} ${e.y1}`;for(let e=0;e<t.length-1;e++){let[r,i]=t[e],[a,o]=t[e+1];n+=` Q ${r} ${i} ${(r+a)/2} ${(i+o)/2}`}let r=t[t.length-1];return n+=` Q ${r[0]} ${r[1]} ${e.x2} ${e.y2}`,n}if(r===3){let e=`M ${n[0][0]} ${n[0][1]}`;for(let t=0;t<n.length-1;t++){let[r,i]=n[t],[a,o]=n[t+1];e+=Math.abs(a-r)>=Math.abs(o-i)?` L ${a} ${i} L ${a} ${o}`:` L ${r} ${o} L ${a} ${o}`}return e}let i=`M ${n[0][0]} ${n[0][1]}`;for(let e=1;e<n.length;e++)i+=` L ${n[e][0]} ${n[e][1]}`;return i};return e.renderFlowgo=k,e})({});
"use strict";
(() => {
  // src/hydrate.ts
  var EMBED_SELECTOR = ".flowgo-embed";
  var HYDRATED_ATTR = "data-flowgo-hydrated";
  var SOURCE_ATTR = "data-flowgo-source";
  var decodeBase64Utf8 = (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  };
  var hydrateFlowgoEmbeds = (root = document) => {
    const renderer = window.FlowgoInline;
    if (!renderer) {
      console.warn(
        "[remark-flowgo] window.FlowgoInline is not defined -- load flowgo-inline.js (or the bundled remark-flowgo/client script, which includes it) before calling hydrateFlowgoEmbeds()."
      );
      return 0;
    }
    const nodes = root.querySelectorAll(`${EMBED_SELECTOR}:not([${HYDRATED_ATTR}])`);
    let hydrated = 0;
    nodes.forEach((el) => {
      const encoded = el.getAttribute(SOURCE_ATTR);
      if (encoded == null) return;
      let source;
      try {
        source = decodeBase64Utf8(encoded);
      } catch (err) {
        console.error("[remark-flowgo] failed to decode data-flowgo-source", err);
        return;
      }
      renderer.renderFlowgo(el, source);
      el.setAttribute(HYDRATED_ATTR, "");
      hydrated++;
    });
    return hydrated;
  };

  // src/browser-entry.ts
  var run = () => {
    hydrateFlowgoEmbeds(document);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
  window.flowgoRemark = {
    hydrate: hydrateFlowgoEmbeds
  };
})();

