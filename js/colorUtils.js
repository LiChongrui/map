/**
 * 颜色工具 + 应用内取色器
 *
 * 从 uiManager.js 拆出（R162），供样式面板、标注面板、图例色块共用。
 * 取色器本身不感知「样式面板 / 标注面板」，面板侧的副作用由调用方通过 onChange 回调注入，
 * 避免底层工具反向依赖上层面板。
 *
 * 依赖：无（纯 DOM + 数学）
 */

const ColorUtils = (function() {

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[character]));
    }

    function hexToRgba(hex, alpha) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return hex;
        const int = parseInt(match[1], 16);
        const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // 不透明度钳制到 0~1（非法值按 1 处理）
    function clamp01(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 1;
        return Math.min(1, Math.max(0, num));
    }

    // 按当前样式生成图层图例（与地图显示严格对应：点大小/边线宽、线宽、填充/描边/边线不透明度）
    // 注意：不加投影阴影——阴影会让细线/小点看起来比地图实际渲染的更大
    // R111：图例色块尺寸固定——无论样式如何（线宽/点大小/描边），其在图层元素中占用的宽高不变；
    // 颜色仍如实反映样式，但符号尺寸被归一化（点 12、线 16×3、面/混合由 CSS 固定），不再缩放。
    // R111/R113：图例「块」元素固定 24×28（CSS），内部符号为固定好看的表示（不随样式大小变化），避免布局抖动
    const CP_PRESETS = [
        '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
        '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
        '#4f6ef7', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
        '#ec4899', '#78716c', '#334155', '#64748b', '#ffffff',
    ];
    let activeColorPicker = null;

    // 规范化 hex（#rgb → #rrggbb；非法值回退默认蓝）
    function normalizeHex(value) {
        let hex = String(value ?? '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(hex)) {
            hex = hex.split('').map(ch => ch + ch).join('');
        }
        if (!/^[0-9a-f]{6}$/i.test(hex)) hex = '4f6ef7';
        return `#${hex.toLowerCase()}`;
    }
    function rgbToHex(r, g, b) {
        const to2 = n => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
        return `#${to2(r)}${to2(g)}${to2(b)}`;
    }
    function hsvToHex(h, s, v) {
        const c = v * s;
        const hp = (((h % 360) + 360) % 360) / 60;
        const x = c * (1 - Math.abs(hp % 2 - 1));
        let r = 0, g = 0, b = 0;
        if (hp < 1) [r, g, b] = [c, x, 0];
        else if (hp < 2) [r, g, b] = [x, c, 0];
        else if (hp < 3) [r, g, b] = [0, c, x];
        else if (hp < 4) [r, g, b] = [0, x, c];
        else if (hp < 5) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        const m = v - c;
        return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
    }
    function hexToHsv(hex) {
        const norm = normalizeHex(hex).slice(1);
        const r = parseInt(norm.slice(0, 2), 16) / 255;
        const g = parseInt(norm.slice(2, 4), 16) / 255;
        const b = parseInt(norm.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        return { h, s: max === 0 ? 0 : d / max, v: max };
    }
    function closeColorPicker() {
        if (!activeColorPicker) return;
        const { popover, onGlobalPointerDown, onKeydown } = activeColorPicker;
        document.removeEventListener('pointerdown', onGlobalPointerDown, true);
        document.removeEventListener('keydown', onKeydown, true);
        popover.remove();
        activeColorPicker = null;
    }
    function openColorPicker(btn, id, opts) {
        closeColorPicker();
        const key = btn.dataset.colorKey;
        const mode = (opts && opts.mode === 'label') ? 'label' : 'style';
        if (!key) return;
        let initialHex;
        if (mode === 'label') {
            initialHex = normalizeHex(btn.dataset.color || (key === 'textColor' ? '#334155' : '#ffffff'));
        } else {
            const style = LayerManager.getLayerStyle(id);
            if (!style) return;
            initialHex = normalizeHex(style[key]);
        }

        let hsv = hexToHsv(initialHex);

        const popover = document.createElement('div');
        popover.className = 'color-picker-pop';
        popover.innerHTML = `
            <div class="cp-sv"><div class="cp-sv-cursor"></div></div>
            <input type="range" class="cp-hue" min="0" max="360" step="1" aria-label="色相" />
            <div class="cp-presets"></div>
            <div class="cp-hex-row">
                <span class="cp-hex-label">HEX</span>
                <input type="text" class="cp-hex-input" maxlength="7" spellcheck="false" />
            </div>
        `;
        document.body.appendChild(popover);

        const svArea = popover.querySelector('.cp-sv');
        const svCursor = popover.querySelector('.cp-sv-cursor');
        const hueRange = popover.querySelector('.cp-hue');
        const presetsBox = popover.querySelector('.cp-presets');
        const hexInput = popover.querySelector('.cp-hex-input');

        presetsBox.innerHTML = CP_PRESETS.map(hex =>
            `<button type="button" class="cp-preset" data-hex="${hex}" style="background:${hex};" aria-label="选择颜色 ${hex}"></button>`
        ).join('');

        // 实时应用到图层样式与按钮显示；取色器内 HEX 输入框同步跟随
        // （用户正在输入时不回写，避免打断输入）
        // R110：applyColor 只更新取色器自身的显示（色块 / hex 文本）。
        // 「写入预览工作副本 + 刷新示例」等面板副作用由调用方通过 opts.onChange 处理，
        // 避免色彩工具反向依赖样式面板 / 标注面板（两者都要用到它）。
        const onChange = (opts && typeof opts.onChange === 'function') ? opts.onChange : null;
        const applyColor = function(hex) {
            btn.dataset.color = hex;
            const swatch = btn.querySelector('.color-field-swatch');
            if (swatch) swatch.style.background = hex;
            const hexEl = btn.querySelector('.hex-val') || document.querySelector(`[data-hex-for="${key}"]`);
            if (hexEl) hexEl.textContent = hex.toUpperCase();
            if (document.activeElement !== hexInput) {
                hexInput.value = hex.toUpperCase();
            }
            if (onChange) onChange(hex);
        };

        const render = function() {
            svArea.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})`;
            svCursor.style.left = `${hsv.s * 100}%`;
            svCursor.style.top = `${(1 - hsv.v) * 100}%`;
            svCursor.style.background = hsvToHex(hsv.h, hsv.s, hsv.v);
            hueRange.value = String(Math.round(hsv.h));
        };

        // 定位：按钮下方优先，空间不足翻到上方，整体限制在视口内（fixed 定位不受弹窗裁剪/遮挡）
        popover.style.visibility = 'hidden';
        const popRect = popover.getBoundingClientRect();
        const rect = btn.getBoundingClientRect();
        let left = Math.min(Math.max(8, rect.left), window.innerWidth - popRect.width - 8);
        let top = rect.bottom + 8;
        if (top + popRect.height > window.innerHeight - 8) {
            top = Math.max(8, rect.top - popRect.height - 8);
        }
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
        popover.style.visibility = '';

        // SV 面板拖拽选色
        const pickFromSv = function(event) {
            const box = svArea.getBoundingClientRect();
            hsv.s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
            hsv.v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
            render();
            applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
        };
        svArea.addEventListener('pointerdown', function(event) {
            event.preventDefault();
            svArea.setPointerCapture(event.pointerId);
            pickFromSv(event);
            const onMove = e => pickFromSv(e);
            const onUp = function() {
                svArea.removeEventListener('pointermove', onMove);
                svArea.removeEventListener('pointerup', onUp);
            };
            svArea.addEventListener('pointermove', onMove);
            svArea.addEventListener('pointerup', onUp);
        });

        hueRange.addEventListener('input', function() {
            hsv.h = parseFloat(this.value) || 0;
            render();
            applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
        });

        presetsBox.addEventListener('click', function(event) {
            const preset = event.target.closest('.cp-preset');
            if (!preset) return;
            hsv = hexToHsv(preset.dataset.hex);
            hexInput.value = preset.dataset.hex.toUpperCase();
            render();
            applyColor(preset.dataset.hex);
        });

        hexInput.value = normalizeHex(initialHex).toUpperCase();
        const commitHex = function() {
            const hex = normalizeHex(hexInput.value);
            hexInput.value = hex.toUpperCase();
            hsv = hexToHsv(hex);
            render();
            applyColor(hex);
        };
        hexInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitHex();
                hexInput.blur();
            }
        });
        hexInput.addEventListener('input', function() {
            const raw = this.value.trim();
            if (/^#?[0-9a-f]{6}$/i.test(raw)) {
                const hex = normalizeHex(raw);
                hsv = hexToHsv(hex);
                render();
                applyColor(hex);
            }
        });
        hexInput.addEventListener('blur', commitHex);

        // 点击取色器外部 / 按 Escape 关闭
        const onGlobalPointerDown = function(event) {
            if (!popover.contains(event.target) && !btn.contains(event.target)) closeColorPicker();
        };
        const onKeydown = function(event) {
            if (event.key === 'Escape') closeColorPicker();
        };
        document.addEventListener('pointerdown', onGlobalPointerDown, true);
        document.addEventListener('keydown', onKeydown, true);

        render();
        activeColorPicker = { popover, btn, onGlobalPointerDown, onKeydown };
    }
    function colorField(key, label, value) {
        const hex = normalizeHex(value);
        return `
            <div class="style-field">
                <label>${label}</label>
                <div class="style-control">
                    <button type="button" class="color-field-btn" data-color-key="${key}" data-color="${escapeHtml(hex)}">
                        <span class="color-field-swatch" style="background:${escapeHtml(hex)};"></span>
                        <span class="hex-val" data-hex-for="${key}">${escapeHtml(hex.toUpperCase())}</span>
                        <i class="fas fa-chevron-down color-field-caret"></i>
                    </button>
                </div>
            </div>
        `;
    }

    // R111/R112：标注面板的颜色字段——与图例/样式配置使用同一套自定义取色器 UI（.color-field-btn + 弹层）
    // R112：移除「默认」按钮（颜色始终为具体取值，保持与本项目风格一致）
    // R170：legendColor 由调用方（标注面板）传入——图例色是标注面板的状态，
    // 本模块若直接引用会造成跨模块隐式依赖（拆分时曾因此抛 labelLegendColor is not defined）。
    function labelColorField(key, label, value, legendColor) {
        // R114：文字颜色空值默认取图例色，扫边颜色无图例概念则默认白
        const def = key === 'textColor' ? (legendColor || '#334155') : '#ffffff';
        const hex = normalizeHex(value || def);
        return `
            <div class="style-field">
                <label>${label}</label>
                <div class="style-control">
                    <button type="button" class="color-field-btn" data-color-key="${key}" data-color="${escapeHtml(hex)}" data-label-color="1">
                        <span class="color-field-swatch" style="background:${escapeHtml(hex)};"></span>
                        <span class="hex-val" data-hex-for="${key}">${escapeHtml(hex.toUpperCase())}</span>
                        <i class="fas fa-chevron-down color-field-caret"></i>
                    </button>
                </div>
            </div>`;
    }

    // R114：自定义下拉组件（替代原生 select，彻底解决原生下拉的 OS 样式/悬停不可定制问题）。
    // options: [{value, text}]；customSelectHTML 仅产出结构，绑定见 bindCustomSelect。
    function customSelectHTML(id, options, currentValue) {
        const cur = options.find(o => o.value === currentValue);
        const curText = cur ? cur.text : (options[0] ? options[0].text : '');
        const opts = options.map(o =>
            `<div class="custom-select-option ${o.value === currentValue ? 'selected' : ''}" data-value="${escapeHtml(o.value)}" role="option" aria-selected="${o.value === currentValue}">${escapeHtml(o.text)}</div>`
        ).join('');
        return `
            <div class="custom-select" id="${id}" data-value="${escapeHtml(currentValue)}" tabindex="0">
                <div class="custom-select-trigger">
                    <span class="custom-select-value">${escapeHtml(curText)}</span>
                    <i class="fas fa-chevron-down custom-select-caret"></i>
                </div>
                <div class="custom-select-options" role="listbox">${opts}</div>
            </div>`;
    }

    // 当前打开的取色器（供面板判断「再次点击同一按钮 = 收起」，不直接暴露内部对象）
    function getActivePicker() {
        return activeColorPicker;
    }

    // ---------- 公开 API ----------
    return {
        // 色彩换算
        escapeHtml,
        normalizeHex,
        rgbToHex,
        hsvToHex,
        hexToHsv,
        hexToRgba,
        clamp01,
        // 应用内取色器
        openColorPicker,
        closeColorPicker,
        getActivePicker,
        // 表单片段
        colorField,
        labelColorField,
        customSelectHTML,
    };

})();
