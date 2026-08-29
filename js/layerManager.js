/**
 * 图层管理 - 支持多GeoJSON独立控制
 */

const LayerManager = (function() {
    const layers = new Map();
    // R87：数据集级显隐集合（按数据集名）。隐藏某数据集时只把其图层移出地图，
    // 不修改各图层自身的 info.visible（个体显隐状态保留），再次显示时按各自状态恢复。
    const datasetHidden = new Set();

    // ---------- 标注全局设置（R106：字段 / 文字色 / 扫边 / 字体，跨会话持久化） ----------
    const LABEL_STORAGE_KEY = 'lyc_label_settings_v1';
    function defaultLabelSettings() {
        return { field: '', textColor: '', haloColor: '', haloWidth: '', fontFamily: '', fontSize: '', textOpacity: '', haloOpacity: '', show: null };
    }
    function loadLabelSettings() {
        try {
            const v = JSON.parse(localStorage.getItem(LABEL_STORAGE_KEY));
            if (v && typeof v === 'object') {
                const merged = Object.assign(defaultLabelSettings(), v);
                // R109：旧版曾把全局默认字体误存为「宋体」，归一化为空（默认字体），
                // 使未自定义字体的图层一律使用现代无衬线默认字体而非宋体
                if (merged.fontFamily === '"SimSun","Songti SC",serif') {
                    merged.fontFamily = '';
                    try { localStorage.setItem(LABEL_STORAGE_KEY, JSON.stringify(merged)); } catch (e) {}
                }
                return merged;
            }
        } catch (e) { /* 解析失败用默认 */ }
        return defaultLabelSettings();
    }
    let labelSettings = loadLabelSettings();

    // R108：每图层标注覆盖设置（全局标注基础上按图层单独调整）
    const LAYER_LABEL_STORAGE_KEY = 'lyc_layer_label_settings_v1';
    const labelOverrides = new Map();
    function loadLayerLabelOverrides() {
        try {
            const v = JSON.parse(localStorage.getItem(LAYER_LABEL_STORAGE_KEY));
            if (v && typeof v === 'object') return new Map(Object.entries(v));
        } catch (e) { /* 解析失败则清空 */ }
        return new Map();
    }
    labelOverrides.set('__init__', true); // 占位，随后清空
    (function initLayerLabelOverrides() {
        const loaded = loadLayerLabelOverrides();
        labelOverrides.clear();
        loaded.forEach((value, key) => labelOverrides.set(key, value));
    })();
    function persistLayerLabelOverrides() {
        try {
            const obj = Object.fromEntries(labelOverrides);
            localStorage.setItem(LAYER_LABEL_STORAGE_KEY, JSON.stringify(obj));
        } catch (e) { /* 存储失败不阻塞 */ }
    }
    function getEffectiveLabelSettings(id, override) {
        override = override || labelOverrides.get(id) || {};
        const merged = Object.assign({}, labelSettings, override);
        // R115：全局标注面板自 R110 起已不可达，全局 textColor/haloColor 成为静默覆盖各图层
        // 图例色的「孤儿」设置。未在某图层显式设置文字色/扫边色时，应回落到图例色（文字）/
        // 白色（扫边），而非继承孤儿全局色——满足「默认标注颜色从图例颜色提取」。
        if (!('textColor' in override) || !override.textColor) merged.textColor = '';
        if (!('haloColor' in override) || !override.haloColor) merged.haloColor = '';
        return merged;
    }

    // 数据集加载状态监听（UIManager 用以显示/隐藏「加载中」遮罩）
    const loadingListeners = [];
    function emitLoading(state, name) {
        loadingListeners.forEach(fn => { try { fn(state, name); } catch (e) {} });
    }
    function setLoadingListener(fn) {
        if (typeof fn === 'function' && !loadingListeners.includes(fn)) loadingListeners.push(fn);
    }

    // ---------- 样式生成 ----------
    const STYLE_STORAGE_KEY = 'lyc_layer_styles_v1';
    // ---------- 图层顺序持久化（拖拽排序后跨会话保留） ----------
    const ORDER_STORAGE_KEY = 'lyc_layer_order_v1';

    function readSavedOrder() {
        try {
            const value = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY));
            return Array.isArray(value) ? value : null;
        } catch (error) { return null; }
    }

    function persistOrder(orderedIds) {
        try {
            localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orderedIds));
        } catch (error) { /* 存储失败不阻塞交互 */ }
    }

    // 清单数据集顺序（数据源 id 序列）：作为无手动排序时的稳定基准顺序
    function getCanonicalLayerSequence() {
        const datasets = DataScanner.getDatasets();
        if (!datasets || !datasets.length) return null;
        const seq = [];
        datasets.forEach(d => (d.sources || []).forEach(s => seq.push(s.id)));
        return seq;
    }

    // 新加载的数据集默认置于顶部：将新图层 id 整体置顶（内部按清单顺序稳定排列，
    // 保证批量添加（「添加全部」）结果可预测），并持久化顺序。所有数据集一视同仁，
    // 包括启动时默认加载的数据集（无特殊基准层待遇）。
    // 调用方（批量添加）应在所有数据集加载完成后、finalizeBatchLoad 之前调用一次。
    function prependNewLayersOnTop(newIds) {
        if (!newIds || newIds.length === 0) return;
        const seq = getCanonicalLayerSequence();
        const sorted = seq
            ? newIds.slice().sort((a, b) => {
                const ia = seq.indexOf(a), ib = seq.indexOf(b);
                return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
            })
            : newIds.slice();
        const current = readSavedOrder() || [...layers.keys()].filter(id => !newIds.includes(id));
        const filtered = current.filter(id => !newIds.includes(id));
        persistOrder([...sorted, ...filtered]);
    }

    // 有手动排序时，把「不在 savedOrder 中的新增图层」按清单数据集顺序插入到合适邻位，
    // 而非一律追加到末尾（解决：移除某数据集后重新添加，它总是落在最后一个图层的问题）
    function insertAtCanonicalPositions(remaining) {
        const seq = getCanonicalLayerSequence();
        const byId = new Map(layers); // 当前 = savedOrder 子集
        const savedList = [...layers.keys()];
        const rankOf = id => {
            const info = byId.get(id);
            const group = info ? (info.config.group || '未分组') : null;
            const idx = DataScanner.getDatasets().findIndex(d => d.name === group);
            return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
        };
        const remainingSorted = seq
            ? remaining.slice().sort((a, b) => {
                const ia = seq.indexOf(a), ib = seq.indexOf(b);
                return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
            })
            : remaining.slice();
        const result = [];
        const inserted = new Set();
        for (const sid of savedList) {
            const srank = rankOf(sid);
            for (const rid of remainingSorted) {
                if (inserted.has(rid)) continue;
                if (rankOf(rid) < srank) { result.push(rid); inserted.add(rid); }
            }
            result.push(sid);
        }
        for (const rid of remainingSorted) {
            if (!inserted.has(rid)) { result.push(rid); inserted.add(rid); }
        }
        layers.clear();
        result.forEach(id => { if (byId.has(id)) layers.set(id, byId.get(id)); });
    }

    // 按 savedOrder 重排 layers；无手动排序时回落到清单顺序，新增图层插入到对应邻位
    function applySavedOrder() {
        const savedOrder = readSavedOrder();
        // 无保存顺序：保持当前顺序（新数据集已在加载时置顶），无需重排
        if (!savedOrder) return;
        const currentLayers = new Map(layers);
        layers.clear();
        savedOrder.forEach(id => {
            if (currentLayers.has(id)) layers.set(id, currentLayers.get(id));
        });
        const remaining = [];
        currentLayers.forEach((info, id) => { if (!layers.has(id)) remaining.push(id); });
        if (remaining.length) insertAtCanonicalPositions(remaining);
    }

    // 颜色加深（每通道 * factor）：面默认描边 = 填充色的深一档同色系
    function shadeColor(hex, factor = 0.78) {
        if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
        const n = parseInt(hex.slice(1), 16);
        const r = Math.round(((n >> 16) & 255) * factor);
        const g = Math.round(((n >> 8) & 255) * factor);
        const b = Math.round((n & 255) * factor);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }

    // 默认样式配置（由 manifest 配置派生，供面/线/点三类几何使用）
    // 优先级：manifest style 对象逐键 → color 快捷色 → 代码默认值。
    // style 支持键：fillColor/fillOpacity/strokeColor/strokeOpacity/strokeWidth/
    //   lineColor/lineOpacity/lineWidth/pointColor/pointOpacity/pointSize/
    //   pointStrokeColor/pointStrokeOpacity/pointStrokeWidth（及 color 快捷色）
    // 所有颜色均配有透明度（0~1）：fillOpacity/strokeOpacity/lineOpacity/pointOpacity/pointStrokeOpacity
    function defaultStyle(config) {
        const style = (config && config.style) || {};
        const color = style.color || config.color || '#4f6ef7';
        const pick = (key, fallback) => (style[key] !== undefined && style[key] !== null ? style[key] : fallback);
        // 面：填充 = 配置色；描边默认 = 填充色深一档的同色系（用户要求的默认规则）
        const fillColor = pick('fillColor', color);
        return {
            // 面
            fillColor: fillColor,
            fillOpacity: pick('fillOpacity', 0.35),
            strokeColor: pick('strokeColor', shadeColor(fillColor)),
            strokeOpacity: pick('strokeOpacity', 0.95),
            strokeWidth: pick('strokeWidth', 1.5),
            // 线
            lineColor: pick('lineColor', color),
            lineOpacity: pick('lineOpacity', 0.9),
            lineWidth: pick('lineWidth', 2.5),
            // 点
            pointColor: pick('pointColor', color),
            pointOpacity: pick('pointOpacity', 1),
            pointSize: pick('pointSize', 10),
            pointStrokeColor: pick('pointStrokeColor', '#ffffff'),
            pointStrokeOpacity: pick('pointStrokeOpacity', 1),
            pointStrokeWidth: pick('pointStrokeWidth', 2),
        };
    }

    // 读取已保存的样式配置（localStorage 持久化）
    function readSavedStyles() {
        try {
            return JSON.parse(localStorage.getItem(STYLE_STORAGE_KEY)) || {};
        } catch (error) {
            return {};
        }
    }

    // 持久化所有图层样式
    function persistStyles() {
        try {
            const saved = {};
            layers.forEach((info, id) => { saved[id] = info.styleConfig; });
            localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(saved));
        } catch (error) { /* 存储失败不阻塞交互 */ }
    }

    // 按几何类型生成 Leaflet 样式（面/线）；点要素由 pointToLayer 的图标处理
    // 透明度全部来自样式配置：线=lineOpacity，面描边=strokeOpacity，面填充=fillOpacity
    function createStyleFunction(styleConfig) {
        return function(feature) {
            const type = feature?.geometry?.type || '';
            if (type === 'LineString' || type === 'MultiLineString') {
                return {
                    color: styleConfig.lineColor,
                    weight: styleConfig.lineWidth,
                    opacity: clamp01(styleConfig.lineOpacity ?? 0.9),
                    lineCap: 'round',
                    lineJoin: 'round',
                    smoothFactor: 1.5,
                    interactive: true,
                };
            }
            return {
                color: styleConfig.strokeColor,
                weight: styleConfig.strokeWidth,
                opacity: clamp01(styleConfig.strokeOpacity ?? 0.95),
                fillColor: styleConfig.fillColor,
                fillOpacity: clamp01(styleConfig.fillOpacity ?? 0.35),
                lineJoin: 'round',
                smoothFactor: 1.5,
                interactive: true,
            };
        };
    }

    // 点要素图标：实心圆点 + 可配置边线（颜色/透明度/宽度），坐标精确居中
    function createPointIcon(styleConfig) {
        const size = Math.max(4, Number(styleConfig.pointSize) || 10);
        const stroke = Math.max(0, Number(styleConfig.pointStrokeWidth) || 0);
        // 透明度直接混入颜色（rgba），与面/线的透明度语义一致
        const pointColor = hexToRgba(styleConfig.pointColor, clamp01(styleConfig.pointOpacity ?? 1));
        const strokeColor = hexToRgba(styleConfig.pointStrokeColor || '#ffffff', clamp01(styleConfig.pointStrokeOpacity ?? 1));
        const pad = 4;
        const total = size + stroke * 2 + pad * 2;
        const html = `<span class="point-dot" style="width:${size}px;height:${size}px;background:${escapeHtml(pointColor)};border:${stroke}px solid ${escapeHtml(strokeColor)};"></span>`;
        return L.divIcon({
            className: 'map-feature-point-icon',
            html,
            iconSize: [total, total],
            iconAnchor: [total / 2, total / 2],
            // 弹窗锚点在图标顶部中央：direction:top 时弹窗紧贴圆点上方而不是压住圆点
            popupAnchor: [0, -total / 2],
        });
    }

    // 递归更新点要素图标（支持 Point / MultiPoint 分组）
    function restylePoints(layerGroup, styleConfig) {
        if (layerGroup instanceof L.Marker) {
            layerGroup.setIcon(createPointIcon(styleConfig));
            return;
        }
        if (typeof layerGroup.eachLayer === 'function') {
            layerGroup.eachLayer(subLayer => restylePoints(subLayer, styleConfig));
        }
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[character]));
    }

    // 透明度钳制到 0~1（非法值按 1 处理）
    function clamp01(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 1;
        return Math.min(1, Math.max(0, num));
    }

    // hex → rgba（把透明度混入颜色，供点图标等 HTML 内联样式使用）
    function hexToRgba(hex, alpha) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return hex;
        const int = parseInt(match[1], 16);
        const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
        return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
    }

    // 几何大类：point | line | polygon | null（Multi* 归入对应大类）
    function getGeometryKind(geometry) {
        const type = geometry?.type || '';
        if (type === 'Point' || type === 'MultiPoint') return 'point';
        if (type === 'LineString' || type === 'MultiLineString') return 'line';
        if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
        return null;
    }

    // 图层主题色（标注文字、图例、图层色块统一取色源，随样式配置实时变化）
    function getThemeColor(styleConfig, kind) {
        if (!styleConfig) return null;
        if (kind === 'point') return styleConfig.pointColor;
        if (kind === 'line') return styleConfig.lineColor;
        return styleConfig.fillColor || styleConfig.strokeColor;
    }

    // ---------- 标注定位 ----------

    // 射线法：点 (x,y) 是否在某环内（直接基于经纬度，无需缩放）
    function inRingXY(x, y, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
        }
        return inside;
    }

    // 点 (x,y) 是否在某组多边形内（任一外环内且不在任何洞内）。
    // polygons 元素为 [ring, hole, ...]（Polygon / MultiPolygon 的单块坐标）
    function insidePolygons(x, y, polygons) {
        for (const polygon of polygons || []) {
            const rings = Array.isArray(polygon[0][0]) ? polygon : [polygon];
            const outer = rings[0];
            if (!outer || outer.length < 3) continue;
            if (!inRingXY(x, y, outer)) continue;
            let inHole = false;
            for (let h = 1; h < rings.length; h++) {
                if (rings[h] && inRingXY(x, y, rings[h])) { inHole = true; break; }
            }
            if (!inHole) return true;
        }
        return false;
    }

    // 面积加权质心（带洞多边形：外环加、内环减）。坐标直接为经纬度，仅用于「标注落点」无需投影
    function polygonCentroid(polygons) {
        let totalArea = 0, cx = 0, cy = 0;
        for (const polygon of polygons || []) {
            const rings = Array.isArray(polygon[0][0]) ? polygon : [polygon];
            for (let r = 0; r < rings.length; r += 1) {
                const ring = rings[r];
                if (!ring || ring.length < 3) continue;
                let a = 0, rx = 0, ry = 0;
                for (let i = 0; i < ring.length - 1; i += 1) {
                    const [x1, y1] = ring[i];
                    const [x2, y2] = ring[i + 1];
                    const cross = x1 * y2 - x2 * y1;
                    a += cross;
                    rx += (x1 + x2) * cross;
                    ry += (y1 + y2) * cross;
                }
                a *= 0.5;
                if (Math.abs(a) < 1e-12) continue;
                const sign = r === 0 ? 1 : -1;
                totalArea += sign * a;
                // R98 修复：分子只累加 sign·rx（rx = Σ(x1+x2)·cross = 6·A_i·Cx_i），
                // 再统一除以 6·totalArea。旧写法误乘 a（面积）导致质心 ≈ 真实重心×面积，
                // 全部坍缩到 (0,0) 附近——即「多边形标注失效」（R92 引入，标注默认关闭未察觉）
                cx += sign * rx;
                cy += sign * ry;
            }
        }
        if (Math.abs(totalArea) < 1e-12) return null;
        // 面积加权质心标准公式：C = (1/(6A)) · Σ(x1+x2)·cross ；此处 totalArea = A = ½·Σcross，
        // 故需除以 6·totalArea（漏除会差 6 倍，导致标注点远离真实重心）
        return L.latLng(cy / (6 * totalArea), cx / (6 * totalArea));
    }

    // 多边形标注点（R97）：按用户要求直接使用「面积加权几何重心」；
    // 仅当重心计算失败（退化几何）时回退到内部点方案
    function polygonLabelPoint(polygons) {
        const c = polygonCentroid(polygons);
        return c || polygonInteriorPoint(polygons);
    }

    // 多边形内部标注点（回退方案）：polylabel 简化版（网格采样 + 细分迭代），
    // 返回「离所有边界最远」的内部点——对凹多边形 / 带洞多边形也保证在多边形内部。
    // 直接使用经纬度网格 + 等距圆柱投影到米做距离比较（按各点自身纬度 cos 缩放），
    // 不再对整片区域套用统一 cos(lat) 缩放，避免大范围多边形（道/路/州等）经度被压缩导致标注点偏东/偏西。
    function polygonInteriorPoint(polygons) {
        const outerRings = [];
        const holes = [];
        for (const polygon of polygons || []) {
            if (Array.isArray(polygon) && polygon.length) {
                if (polygon[0] && polygon[0].length >= 3) outerRings.push(polygon[0]);
                for (let h = 1; h < polygon.length; h++) {
                    if (polygon[h] && polygon[h].length >= 3) holes.push(polygon[h]);
                }
            }
        }
        if (outerRings.length === 0) return null;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const ring of outerRings) {
            for (const c of ring) {
                if (c[0] < minX) minX = c[0];
                if (c[0] > maxX) maxX = c[0];
                if (c[1] < minY) minY = c[1];
                if (c[1] > maxY) maxY = c[1];
            }
        }
        const R = 6378137; // 地球半径（米），等距圆柱投影用
        const toMeters = (x, y) => [x * Math.PI / 180 * R * Math.cos(y * Math.PI / 180), y * Math.PI / 180 * R];
        // 点是否在该多边形（外环并集、挖去洞）内部：复用模块级 insidePolygons
        const inside = (x, y) => insidePolygons(x, y, [outerRings.concat(holes)]);

        const distToSeg = (px, py, ax, ay, bx, by) => {
            const A = toMeters(ax, ay), B = toMeters(bx, by), P = toMeters(px, py);
            const dx = B[0] - A[0], dy = B[1] - A[1];
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2)) : 0;
            return Math.hypot(P[0] - (A[0] + dx * t), P[1] - (A[1] + dy * t));
        };
        const distToBoundary = (x, y) => {
            let min = Infinity;
            const all = outerRings.concat(holes);
            for (const ring of all) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const d = distToSeg(x, y, ring[i][0], ring[i][1], ring[j][0], ring[j][1]);
                    if (d < min) min = d;
                }
            }
            return min;
        };

        // 网格采样（28×28），取内部「离边界最远」的点（坐标均为经纬度，直接返回无需反算）
        const stepX = (maxX - minX) / 28 || 1e-6, stepY = (maxY - minY) / 28 || 1e-6;
        let bestX = null, bestY = null, bestDist = -1;
        for (let i = 0; i <= 28; i++) {
            for (let j = 0; j <= 28; j++) {
                const x = minX + i * stepX;
                const y = minY + j * stepY;
                if (!inside(x, y)) continue;
                const d = distToBoundary(x, y);
                if (d > bestDist) { bestDist = d; bestX = x; bestY = y; }
            }
        }
        if (bestX === null) return null;

        // 细分 3 轮：围绕当前最优点在缩小一半的 cell 邻域内继续找更远点
        let cell = Math.max(stepX, stepY) / 2;
        let cx = bestX, cy = bestY;
        for (let it = 0; it < 3; it++) {
            let found = false;
            for (let i = -1; i <= 1 && !found; i++) {
                for (let j = -1; j <= 1; j++) {
                    const x = cx + i * cell, y = cy + j * cell;
                    if (!inside(x, y)) continue;
                    const d = distToBoundary(x, y);
                    if (d > bestDist) { bestDist = d; bestX = x; bestY = y; found = true; }
                }
            }
            if (found) { cx = bestX; cy = bestY; }
            cell /= 2;
        }
        return L.latLng(bestY, bestX);
    }

    // 判断一条线（LineString / 多段线）是否为闭合环（首末点重合），用于把城墙等闭合线按面处理
    function isClosedLine(geometry) {
        if (!geometry) return false;
        const lines = geometry.type === 'LineString'
            ? [geometry.coordinates]
            : (geometry.type === 'MultiLineString' ? geometry.coordinates : []);
        for (const line of lines) {
            if (!line || line.length < 4) continue;
            const a = line[0], b = line[line.length - 1];
            if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return true;
        }
        return false;
    }

    // 线标注点：按累计长度取整条线中点，并返回中点所在段的屏幕方向角（用于判断是否垂直排列标注）
    function lineCenter(lines) {
        const segments = [];
        let total = 0;
        for (const line of lines) {
            for (let i = 1; i < line.length; i += 1) {
                const a = line[i - 1];
                const b = line[i];
                const len = L.latLng(a[1], a[0]).distanceTo(L.latLng(b[1], b[0]));
                segments.push({ a, b, len });
                total += len;
            }
        }
        if (!total) {
            let lng = 0, lat = 0, n = 0;
            for (const line of lines) {
                for (const c of line) { lng += c[0]; lat += c[1]; n += 1; }
            }
            return n ? { position: L.latLng(lat / n, lng / n), angle: 0 } : null;
        }
        let target = total / 2;
        for (let i = 0; i < segments.length; i += 1) {
            const seg = segments[i];
            if (target <= seg.len || i === segments.length - 1) {
                const ratio = seg.len ? target / seg.len : 0;
                const position = L.latLng(
                    seg.a[1] + (seg.b[1] - seg.a[1]) * ratio,
                    seg.a[0] + (seg.b[0] - seg.a[0]) * ratio
                );
                return { position, angle: segmentAngle(seg.a, seg.b) };
            }
            target -= seg.len;
        }
        return null;
    }

    // 两坐标点的屏幕方向角（度），规范到 -90 ~ 90 保证文字不颠倒
    function segmentAngle(a, b) {
        const map = MapManager.getMap();
        if (!map) return 0;
        const p1 = map.latLngToContainerPoint(L.latLng(a[1], a[0]));
        const p2 = map.latLngToContainerPoint(L.latLng(b[1], b[0]));
        let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;
        return Math.round(angle * 10) / 10;
    }

    function getLabelPosition(geometry) {
        if (!geometry) return null;
        const coordinates = geometry.coordinates;

        switch (geometry.type) {
            case 'Point':
                return L.latLng(coordinates[1], coordinates[0]);

            case 'MultiPoint': {
                if (!coordinates.length) return null;
                let lng = 0, lat = 0;
                for (const c of coordinates) { lng += c[0]; lat += c[1]; }
                return L.latLng(lat / coordinates.length, lng / coordinates.length);
            }

            case 'LineString': {
                const centerInfo = lineCenter([coordinates]);
                return centerInfo ? centerInfo.position : null;
            }

            case 'MultiLineString': {
                const centerInfo = lineCenter(coordinates);
                return centerInfo ? centerInfo.position : null;
            }

            case 'Polygon':
                return polygonLabelPoint([coordinates]);

            case 'MultiPolygon':
                return polygonLabelPoint(coordinates);

            case 'GeometryCollection':
                for (const sub of (geometry.geometries || [])) {
                    const pos = getLabelPosition(sub);
                    if (pos) return pos;
                }
                return null;

            default:
                break;
        }

        const fallback = L.geoJSON({ type: 'Feature', geometry }).getBounds();
        return fallback.isValid() ? fallback.getCenter() : null;
    }

    // 标注字段：按「更像名称」的启发式挑选最合适的属性字段，而非简单取第一个。
    // 评分：① 字段名精确为 name/名称/地名 最高；② 字段值基数（distinct 数）越高越像实体名；
    // ③ 非空值数量越多越优先。解决如「州府」数据集第一个字段是「道」（上级区划）导致标注错位的问题。
    function getLabelField(data) {
        const feats = data.features || [];
        const keys = new Set();
        for (const f of feats) Object.keys(f.properties || {}).forEach(k => keys.add(k));
        const keyList = [...keys];
        if (keyList.length === 0) return null;

        const EXACT = ['name', '名称', '地名', 'label', 'title'];
        let bestKey = null, bestScore = -1;
        for (const key of keyList) {
            const kl = key.toLowerCase();
            let score = 0;
            if (EXACT.includes(kl) || EXACT.includes(key)) score += 1000;
            let nonEmpty = 0, distinct = new Set();
            for (const f of feats) {
                const v = f.properties ? f.properties[key] : undefined;
                if (v === undefined || v === null) continue;
                const s = String(v).trim();
                if (!s) continue;
                nonEmpty += 1;
                distinct.add(s);
            }
            score += nonEmpty + distinct.size * 3;
            if (score > bestScore) { bestScore = score; bestKey = key; }
        }
        return bestKey;
    }

    // 要素标注文本：标注字段值 trim；空值返回空字符串（该要素不显示标注）
    function getFeatureLabel(feature, labelField) {
        if (!labelField) return '';
        return String(feature.properties?.[labelField] ?? '').trim();
    }

    function createLabelLayer(data, styleConfig, labelOpts) {
        labelOpts = labelOpts || labelSettings;
        const labelLayer = L.layerGroup();
        // 标注字段：用户全局指定则优先，否则每图层自动选取（第一个有值的属性字段）
        const labelField = labelOpts.field || getLabelField(data);
        data.features.forEach(feature => {
            // trim 过滤纯空白值（数据中存在单个空格的标注值，会渲染出空标注）
            const name = getFeatureLabel(feature, labelField);
            if (!name) return;
            const geometry = feature.geometry;
            if (!geometry) return;
            let position = getLabelPosition(geometry);
            if (!position) return;

            // 标注主题色：默认随图层主色（面=填充色/线=线色/点=点色）；用户自定义文字色则覆盖
            const kind = getGeometryKind(geometry) || 'polygon';
            let labelColor = getThemeColor(styleConfig, kind) || '#334155';
            if (labelOpts.textColor) labelColor = labelOpts.textColor;
            // 统一归类到 point / linestring / polygon 三个样式类，Multi* 也能正确居中
            let geomClass = kind === 'point' ? 'point' : (kind === 'line' ? 'linestring' : 'polygon');

            let vertical = false;
            let offsetAttr = '';
            // 闭合环线（如城墙）：按「面」处理，标注落在环内而非周长中点（避免标签贴在外侧城墙上）
            let closedLine = false;
            if (kind === 'line' && isClosedLine(geometry)) {
                const poly = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
                const interior = polygonInteriorPoint(poly);
                if (interior) { position = interior; geomClass = 'polygon'; closedLine = true; }
            }

            // R97：线要素标注放在「线上中心位置」（lineCenter 中点即在线上），
            // 不再沿法线偏移到线旁；配合 CSS 居中锚定（translate(-50%,-50%)）实现水平垂直双居中。
            // 文字色带晕渲描边，压线也保持可读。
            if (kind === 'line' && !closedLine) {
                offsetAttr = '';
            }

            // 点要素：标注抬升量随点大小/边线变化，紧贴圆点上方（间隙为 0）
            if (kind === 'point') {
                const size = Math.max(4, Number(styleConfig.pointSize) || 10);
                const stroke = Math.max(0, Number(styleConfig.pointStrokeWidth) || 0);
                offsetAttr = `;--label-offset:${Math.round(size / 2 + stroke)}px`;
            }

            const labelClass = `map-feature-label map-feature-label--${geomClass}${vertical ? ' map-feature-label--vertical' : ''}`;
            // 标注样式：基础色经 CSS 变量传递（暗色主题下由 CSS 提亮）；若用户设了自定义项，则叠加内联样式覆盖
            const textOpacity = (labelOpts.textOpacity === '' || labelOpts.textOpacity == null) ? 1 : clamp01(Number(labelOpts.textOpacity));
            const labelStyleParts = [`--label-color:${escapeHtml(labelColor)}${offsetAttr}`];
            if (labelOpts.textColor) labelStyleParts.push(`color:${escapeHtml(hexToRgba(labelColor, textOpacity))}`);
            if (labelOpts.haloColor) {
                const haloOpacityVal = (labelOpts.haloOpacity === '' || labelOpts.haloOpacity == null) ? 1 : clamp01(Number(labelOpts.haloOpacity));
                labelStyleParts.push(`--label-halo:${escapeHtml(hexToRgba(labelOpts.haloColor, haloOpacityVal))}`);
            }
            if (labelOpts.haloWidth !== '' && labelOpts.haloWidth != null) labelStyleParts.push(`-webkit-text-stroke-width:${Number(labelOpts.haloWidth)}px`);
            if (labelOpts.fontFamily) labelStyleParts.push(`font-family:${escapeHtml(labelOpts.fontFamily)}`);
            if (labelOpts.fontSize) labelStyleParts.push(`font-size:${Number(labelOpts.fontSize)}px`);
            const styleAttr = labelStyleParts.join(';');
            L.marker(position, {
                icon: L.divIcon({
                    // 外层 wrapper 承载 Leaflet 的定位 transform；真正的居中 transform 放在内层，
                    // 避免被 Leaflet 的内联 transform 覆盖
                    className: 'map-feature-label-wrap',
                    html: `<div class="${labelClass}" style="${styleAttr}">${escapeHtml(String(name))}</div>`,
                    iconSize: null,
                    iconAnchor: [0, 0],
                }),
                interactive: false,
            }).addTo(labelLayer);
        });
        return { labelLayer, labelField };
    }

    // ---------- 弹窗绑定 ----------
    // 要素选中高亮色（应用主题蓝，区别于图层高亮的琥珀色）
    const FEATURE_SELECT_COLOR = '#4f6ef7';

    // layerInfo 容器传入，恢复样式时动态读取最新 styleConfig（用户改样式后不会回退旧样式）
    function bindPopup(feature, layer, layerInfo) {
        if (!feature.properties) return;
        const props = feature.properties;

        const kind = getGeometryKind(feature.geometry);
        const kindIcon = kind === 'point' ? 'fa-location-dot' : kind === 'line' ? 'fa-route' : 'fa-draw-polygon';
        // 弹窗内容延迟到打开时构建：bindPopup 在 L.geoJSON 构建期执行，
        // 此时 layerInfo.labelField 尚未赋值（在 loadLayer 后段才写入），立即求值会丢失标题/字段过滤
        const buildPopupContent = () => {
            // 标题 = 当前要素标注字段的值；小标题 = 所属图层 · 所属数据集
            const title = getFeatureLabel(feature, layerInfo.labelField) || '要素详情';
            const sub = `${layerInfo.config.name || ''} · ${layerInfo.config.group || '未分组'}`;

            // 字段列表：常用字段优先展示，其余属性按原始顺序补充（标注字段已用作标题）
            const rows = [];
            const seen = new Set(['name', 'title']);
            if (layerInfo.labelField) seen.add(layerInfo.labelField);
            const pushRow = (key, value) => {
                if (seen.has(key)) return;
                seen.add(key);
                if (value === null || value === undefined || String(value).trim() === '') return;
                rows.push(`<div class="feature-popup-row"><span class="feature-popup-key">${escapeHtml(key)}</span><span class="feature-popup-val">${escapeHtml(value)}</span></div>`);
            };
            ['type', 'category', 'address', 'description', 'area', 'length'].forEach(field => pushRow(field, props[field]));
            Object.entries(props).forEach(([key, value]) => pushRow(key, value));

            return `
                <div class="feature-popup">
                    <div class="feature-popup-header">
                        <span class="feature-popup-icon"><i class="fas ${kindIcon}"></i></span>
                        <div class="feature-popup-heading">
                            <div class="feature-popup-title">${escapeHtml(title)}</div>
                            <div class="feature-popup-sub">${escapeHtml(sub)}</div>
                        </div>
                    </div>
                    ${rows.length ? `<div class="feature-popup-body">${rows.join('')}</div>` : ''}
                </div>
            `;
        };
        layer.bindPopup(buildPopupContent, {
            direction: 'top',
            autoPan: true,
            autoPanPadding: [24, 24],
            closeButton: true,
            minWidth: 220,
            maxWidth: 300,
        });

        const restoreOriginalStyle = function() {
            if (typeof this.setStyle === 'function') {
                this.setStyle(createStyleFunction(layerInfo.styleConfig)(feature));
            }
            const el = this.getElement?.();
            el?.classList.remove('feature-selected', 'point-marker-selected');
        };

        layer.on('click', function() {
            // 点击任一地图要素时取消图层高亮
            clearLayerHighlight();
            const el = this.getElement?.();
            if (typeof this.setStyle === 'function') {
                const base = createStyleFunction(layerInfo.styleConfig)(feature);
                if (kind === 'line') {
                    this.setStyle({ color: FEATURE_SELECT_COLOR, weight: (base.weight || 2) + 2, opacity: 1 });
                } else {
                    this.setStyle({
                        color: FEATURE_SELECT_COLOR,
                        weight: (base.weight || 1.5) + 1.5,
                        opacity: 1,
                        fillColor: base.fillColor,
                        fillOpacity: Math.min(0.75, clamp01(base.fillOpacity) + 0.12),
                    });
                }
                el?.classList.add('feature-selected');
            } else if (el) {
                el.classList.add('point-marker-selected');
            }
            this.bringToFront?.();
            // 弹窗由 bindPopup 自动在点击时打开，无需手动调用 openPopup
        });
        layer.on('popupclose', restoreOriginalStyle);
    }

    // ---------- 加载单个图层 ----------
    function loadLayer(sourceConfig) {
        const { id, name, url, visible } = sourceConfig;
        const group = sourceConfig.group || '未分组';

        if (layers.has(id)) {
            removeLayer(id);
        }

        return fetch(url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(data => {
                if (!data.features || data.features.length === 0) {
                    console.warn(`⚠️ "${name}" 没有要素`);
                    return null;
                }

                const map = MapManager.getMap();
                // 样式合并：
                //  - manifest 为该图层配置了 style → 完全按 manifest 派生（defaultStyle 已做键级回退：
                //    manifest style 键 > color > 代码默认），**忽略 savedStyles**——manifest 是权威默认，
                //    用户旧 localStorage 不会残留任何键（否则表现为「配置只应用了部分」）
                //  - manifest 未配置 style → 代码默认 + 用户已保存样式
                const savedStyles = readSavedStyles();
                const manifestStyle = sourceConfig.style && typeof sourceConfig.style === 'object'
                    && Object.keys(sourceConfig.style).length > 0;
                const styleConfig = manifestStyle
                    ? { ...defaultStyle(sourceConfig) }
                    : { ...defaultStyle(sourceConfig), ...(savedStyles[id] || {}) };
                const styleFn = createStyleFunction(styleConfig);

                // 先建立 info 容器：popup 恢复样式时通过它动态读取最新 styleConfig
                const layerInfo = {
                    data: data,
                    visible: visible,
                    config: { ...sourceConfig },
                    featureCount: data.features.length,
                    styleConfig,
                    _id: id,
                };

                const geoLayer = L.geoJSON(data, {
                    style: styleFn,
                    pointToLayer: (feature, latlng) => L.marker(latlng, {
                        icon: createPointIcon(styleConfig),
                    }),
                    onEachFeature: (feature, layer) => bindPopup(feature, layer, layerInfo),
                });
                const { labelLayer, labelField } = createLabelLayer(data, styleConfig, getEffectiveLabelSettings(id));

                layerInfo.layer = geoLayer;
                layerInfo.labelLayer = labelLayer;
                layerInfo.labelField = labelField;
                layerInfo.labelsVisible = false;

                layers.set(id, layerInfo);

                // R87：数据集被隐藏时，即使图层本身 visible 也不加入地图（个体状态保留，待数据集重新显示时恢复）
                if (visible && !datasetHidden.has(group)) {
                    geoLayer.addTo(map);
                }

                console.log(`✅ 加载: ${name} (${data.features.length})`);
                updateStats();
                return layerInfo;
            })
            .catch(err => {
                console.error(`❌ 加载 "${name}" 失败:`, err);
                UIManager.showToast(`加载 "${name}" 失败`, 'error');
                return { success: false, id, name };
            });
    }

    // ---------- 按数据集加载 ----------
    // 加载指定数据集的全部图层（已加载的跳过）。opts.defer=true 时仅把图层加入地图、不重排顺序、
    // 不刷新 UI、不弹加载遮罩，交由调用方（批量添加）一次性 finalizeBatchLoad() 统一处理，
    // 避免逐个数据集重复全量重排/重渲染（「添加全部」时尤为明显）。
    // 返回 { loaded, failed }；自定义样式保存在 localStorage，重新添加数据集后自动恢复
    function loadDataset(name, opts) {
        const defer = !!(opts && opts.defer);
        const dataset = DataScanner.getDataset(name);
        if (!dataset) return Promise.resolve({ loaded: 0, failed: 0, ids: [] });

        const pending = dataset.sources.filter(source => !layers.has(source.id));
        if (pending.length === 0) return Promise.resolve({ loaded: 0, failed: 0, ids: [] });

        if (!defer) emitLoading(true, name);
        return Promise.all(pending.map(source => loadLayer(source))).then(() => {
            const newIds = pending.filter(source => layers.has(source.id)).map(source => source.id);
            const loaded = newIds.length;
            const failed = pending.length - loaded;
            if (!defer) {
                // 新添加的数据集默认置于顶部：先更新持久化顺序，再按最终顺序重排叠加次序
                prependNewLayersOnTop(newIds);
                applySavedOrder();
                // 列表越靠上 = 绘制层级越高（reapplyLayerOrder 逆序移动 SVG path）
                reapplyLayerOrder(MapManager.getMap());
                UIManager.updateLayerPanel();
                UIManager.updateLegend();
                updateStats();
                UIManager.updateButtonsState(layers.size > 0);
            }
            return { loaded, failed, ids: newIds };
        }).finally(() => {
            if (!defer) emitLoading(false, name);
        });
    }

    // 批量添加结束后统一重排图层顺序 + 地图叠加次序 + 刷新全部相关 UI（仅执行一次）。
    // 替代逐个数据集重复全量重排/重渲染，逻辑更清晰、无中间态闪烁。
    function finalizeBatchLoad() {
        // 按保存顺序（或清单基准顺序）重排图层列表与地图叠加次序
        applySavedOrder();
        reapplyLayerOrder(MapManager.getMap());
        // 同步两视图（数据集标签刷新已添加态、图层标签重渲染列表）+ 图例 + 统计 + 按钮态
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
        UIManager.updateButtonsState(layers.size > 0);
    }

    // 对外暴露的加载遮罩开关：批量添加时由 addDatasets 统一控制，避免逐个数据集闪烁
    function setLoading(state, label) {
        emitLoading(state, label);
    }

    // 按「列表越靠上 = 绘制层级越高」重设地图叠加次序。
    // 注意：Leaflet 的 layer._order 在首次 addTo 时分配后不再更新（removeLayer+addTo 无法改变
    // SVG path 顺序）——必须直接移动 DOM：把每个图层的 path appendChild 到 SVG 末尾，
    // 逆序遍历（底部图层先移、列表顶部图层最后移 → 顶部在最高层）
    function reapplyLayerOrder(map) {
        const visibleLayers = [...layers.values()].filter(info => info.visible);
        for (let i = visibleLayers.length - 1; i >= 0; i--) {
            const info = visibleLayers[i];
            const renderer = map.getRenderer(info.layer);
            const root = renderer && renderer._rootGroup;
            if (!root) continue;
            info.layer.eachLayer(l => {
                if (l && l._path && l._path.parentNode === root) root.appendChild(l._path);
            });
        }
    }

    // ---------- 移除数据集 ----------
    // 从地图与列表移除该数据集的全部图层；已保存的样式/顺序保留，可随时重新添加恢复
    function removeDataset(name) {
        const map = MapManager.getMap();
        const ids = [...layers.entries()]
            .filter(([, info]) => (info.config.group || '未分组') === name)
            .map(([id]) => id);
        datasetHidden.delete(name);
        if (ids.length === 0) return false;

        ids.forEach(id => {
            if (highlightedId === id) clearLayerHighlight();
            const info = layers.get(id);
            if (!info) return;
            if (info.visible) map.removeLayer(info.layer);
            if (info.labelsVisible) map.removeLayer(info.labelLayer);
            layers.delete(id);
        });

        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
        UIManager.updateButtonsState(layers.size > 0);
        return true;
    }

    // 已加载数据集名列表（按图层表中的出现顺序）
    function getLoadedGroupNames() {
        const names = [];
        layers.forEach(info => {
            const group = info.config.group || '未分组';
            if (!names.includes(group)) names.push(group);
        });
        return names;
    }

    function setLayerOrder(orderedIds) {
        const currentLayers = new Map(layers);
        layers.clear();
        orderedIds.forEach(id => {
            const info = currentLayers.get(id);
            if (info) layers.set(id, info);
        });
        currentLayers.forEach((info, id) => {
            if (!layers.has(id)) layers.set(id, info);
        });

        // 按新顺序重设地图叠加次序（列表越靠上 = 绘制层级越高）
        reapplyLayerOrder(MapManager.getMap());
        persistOrder([...layers.keys()]);
        // 高亮叠加层重新置顶，保证始终位于重排后的图层之上
        if (highlightOverlay) {
            const map = MapManager.getMap();
            map.removeLayer(highlightOverlay);
            highlightOverlay.addTo(map);
        }
        UIManager.updateLayerPanel();
    }

    function setAllVisibility(visible, targetLayers = layers) {
        const map = MapManager.getMap();
        targetLayers.forEach(info => {
            const group = info.config.group || '未分组';
            if (info.visible !== visible) {
                info.visible = visible;
                // R87：数据集被隐藏时，即便「显示全部」也不把图层加到地图（保留数据集隐藏态）
                if (visible && !datasetHidden.has(group)) {
                    map.addLayer(info.layer);
                    if (info.labelsVisible) info.labelLayer.addTo(map);
                } else if (!visible) {
                    map.removeLayer(info.layer);
                    if (info.labelsVisible) map.removeLayer(info.labelLayer);
                }
            }
        });
        // 显示后重设叠加次序（列表越靠上 = 绘制层级越高）
        if (visible) reapplyLayerOrder(map);
        // 批量切换后逐个更新条目 UI，避免全量重建；并刷新工具栏按钮可用态（显示/隐藏按钮随可见状态变化）
        targetLayers.forEach((_, id) => UIManager.updateLayerItem(id));
        UIManager.updateLegend();
        UIManager.updateButtonsState();
        updateStats();
        // 高亮中的图层被批量隐藏时自动取消高亮
        if (highlightedId) {
            const highlighted = layers.get(highlightedId);
            if (highlighted && !highlighted.visible) clearLayerHighlight();
        }
    }

    // ---------- 切换显隐 ----------
    function toggleLayer(id) {
        const info = layers.get(id);
        if (!info) return;

        const map = MapManager.getMap();
        const group = info.config.group || '未分组';

        if (info.visible) {
            map.removeLayer(info.layer);
            if (info.labelsVisible) map.removeLayer(info.labelLayer);
            info.visible = false;
            // 高亮中的图层被隐藏时自动取消高亮
            if (highlightedId === id) clearLayerHighlight();
        } else {
            // R87：数据集被隐藏时，即便图层自身设为可见也不加到地图（受数据集隐藏态约束）
            if (!datasetHidden.has(group)) {
                map.addLayer(info.layer);
                if (info.labelsVisible) info.labelLayer.addTo(map);
            }
            info.visible = true;
        }

        // 只更新该条目的 UI，避免全量重建列表；同时刷新工具栏按钮可用态
        UIManager.updateLayerItem(id);
        UIManager.updateLegend();
        UIManager.updateButtonsState();
        updateStats();
    }

    // ---------- 数据集级显隐（R87） ----------
    // 隐藏/显示「整个数据集」：只把该数据集图层移出/移回地图，不修改各图层自身的 info.visible，
    // 因此再次显示时每个图层按自己原来的显隐状态恢复。与「显示全部/隐藏全部」(setAllVisibility) 语义不同。
    function isDatasetHidden(name) { return datasetHidden.has(name); }

    function setDatasetVisible(name, visible) {
        const map = MapManager.getMap();
        if (visible) datasetHidden.delete(name);
        else datasetHidden.add(name);

        getLayersByGroup(name).forEach(info => {
            if (visible) {
                // 仅当图层自身可见时才加回地图（个体隐藏态被保留）
                if (info.visible) {
                    map.addLayer(info.layer);
                    if (info.labelsVisible) info.labelLayer.addTo(map);
                }
            } else {
                if (map.hasLayer(info.layer)) map.removeLayer(info.layer);
                if (info.labelsVisible && map.hasLayer(info.labelLayer)) map.removeLayer(info.labelLayer);
            }
        });

        reapplyLayerOrder(map);
        updateStats();
        UIManager.updateLegend();
        // R108：同步图层行的 dataset-hidden 禁用态
        if (typeof UIManager !== 'undefined' && UIManager.syncDatasetHiddenStates) UIManager.syncDatasetHiddenStates();
    }

    function toggleDatasetVisible(name) {
        setDatasetVisible(name, datasetHidden.has(name));
    }

    // 遍历全部已加载数据集名（从图层 config.group 去重得到）
    function eachDatasetName(callback) {
        const names = new Set();
        layers.forEach(info => { if (info.config && info.config.group) names.add(info.config.group); });
        names.forEach(callback);
    }

    // 批量显示/隐藏所有数据集（不改动各图层个体显隐状态）——供面板底部「显示/隐藏所有数据集」使用
    function showAllDatasets() {
        eachDatasetName(name => setDatasetVisible(name, true));
    }

    function hideAllDatasets() {
        eachDatasetName(name => setDatasetVisible(name, false));
    }

    // ---------- 移除图层 ----------
    function removeLayer(id) {
        const info = layers.get(id);
        if (!info) return;

        if (highlightedId === id) clearLayerHighlight();
        if (info.visible) {
            MapManager.getMap().removeLayer(info.layer);
        }
        layers.delete(id);

        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
        return true;
    }

    // ---------- 缩放至图层 ----------
    function zoomToLayer(id) {
        const info = layers.get(id);
        if (!info || !info.visible) {
            UIManager.showToast('图层不可见或无数据', 'info');
            return;
        }
        const bounds = info.layer.getBounds();
        if (bounds && bounds.isValid()) {
            MapManager.fitBounds(bounds);
            UIManager.showToast(`缩放到: ${info.config.name}`, 'success');
        }
    }

    function toggleLabels(id) {
        const info = layers.get(id);
        if (!info || !info.labelField) return false;
        const map = MapManager.getMap();
        info.labelsVisible = !info.labelsVisible;
        if (info.labelsVisible && info.visible) info.labelLayer.addTo(map);
        else map.removeLayer(info.labelLayer);
        UIManager.updateLayerItem(id);
        return info.labelsVisible;
    }

    // ---------- 图层高亮（单击图层项时在地图上突出该图层数据） ----------
    const HIGHLIGHT_COLOR = '#f59e0b';
    let highlightedId = null;
    let highlightOverlay = null;

    // 高亮叠加层：独立于原图层，不改动用户样式；实线加粗描边（面/线）+ 脉冲圆环（点）；
    // 开场闪烁由 CSS 动画（.highlight-path / .highlight-ring）完成
    function buildHighlightOverlay(info) {
        const style = info.styleConfig;
        const pointSize = Math.max(4, Number(style.pointSize) || 10);
        const stroke = Math.max(0, Number(style.pointStrokeWidth) || 0);
        const ringSize = pointSize + stroke * 2 + 18;
        return L.geoJSON(info.data, {
            interactive: false,
            style: function() {
                return {
                    color: HIGHLIGHT_COLOR,
                    weight: 4,
                    opacity: 1,
                    fillColor: HIGHLIGHT_COLOR,
                    fillOpacity: 0.2,
                    lineCap: 'round',
                    lineJoin: 'round',
                    className: 'highlight-path',
                };
            },
            pointToLayer: function(feature, latlng) {
                return L.marker(latlng, {
                    interactive: false,
                    icon: L.divIcon({
                        className: 'map-highlight-icon',
                        html: `<span class="highlight-ring" style="width:${ringSize}px;height:${ringSize}px;"></span>`,
                        iconSize: [ringSize, ringSize],
                        iconAnchor: [ringSize / 2, ringSize / 2],
                    }),
                });
            },
        });
    }

    function getHighlightedLayerId() {
        return highlightedId;
    }

    // 取消高亮（无高亮时为安全空操作）
    function clearLayerHighlight() {
        if (!highlightedId) return;
        const previousId = highlightedId;
        highlightedId = null;
        if (highlightOverlay) {
            MapManager.getMap().removeLayer(highlightOverlay);
            highlightOverlay = null;
        }
        UIManager.updateLayerItem(previousId);
    }

    // 高亮指定图层（覆盖式：先清除已有高亮；图层需可见且所在数据集未隐藏）
    function setLayerHighlight(id) {
        const info = layers.get(id);
        if (!info || !info.visible || isDatasetHidden(info.config.group || '未分组')) return false;
        clearLayerHighlight();
        highlightedId = id;
        highlightOverlay = buildHighlightOverlay(info);
        highlightOverlay.addTo(MapManager.getMap());
        UIManager.updateLayerItem(id);
        return true;
    }

    // 样式变化后按最新样式重建高亮叠加层（如点大小变化时圆环同步）
    function refreshHighlightOverlay() {
        if (!highlightedId || !highlightOverlay) return;
        const info = layers.get(highlightedId);
        MapManager.getMap().removeLayer(highlightOverlay);
        highlightOverlay = info ? buildHighlightOverlay(info) : null;
        if (highlightOverlay) highlightOverlay.addTo(MapManager.getMap());
    }

    // ---------- 统计更新 ----------
    // 底部统计栏三量：数据集个数 / 图层总数 / 可见图层总数
    function updateStats() {
        const groups = new Set();
        let visibleCount = 0;
        layers.forEach(info => {
            const group = info.config.group || '未分组';
            groups.add(group);
            // R87：数据集被隐藏时其图层不计入「可见图层」统计
            if (info.visible && !datasetHidden.has(group)) visibleCount += 1;
        });
        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setStat('statDatasets', groups.size);
        setStat('statLayers', layers.size);
        setStat('statVisible', visibleCount);
        // R124：面板头部「图层」标题旁的图层数徽标
        setStat('panelLayerCount', layers.size);
    }

    // ---------- 搜索过滤 ----------
    // 图层名或所属数据集名匹配则显示；整组无匹配时隐藏该分组；返回匹配的图层行数
    function filterLayers(keyword) {
        const lower = String(keyword || '').trim().toLowerCase();
        let matched = 0;
        document.querySelectorAll('.layer-group').forEach(group => {
            const groupName = (group.dataset.group || '').toLowerCase();
            let groupVisible = 0;
            group.querySelectorAll('.layer-item').forEach(item => {
                const info = layers.get(item.dataset.id);
                const name = (info?.config.name || '').toLowerCase();
                // 基于图层数据匹配，不依赖 DOM 属性（属性已转义，避免与原始名称不一致）
                const hit = !lower || name.includes(lower) || groupName.includes(lower);
                item.style.display = hit ? 'flex' : 'none';
                if (hit) {
                    matched += 1;
                    groupVisible += 1;
                }
            });
            group.style.display = groupVisible ? '' : 'none';
        });
        return matched;
    }

    // ---------- 图层样式配置 ----------
    function getLayerStyle(id) {
        const info = layers.get(id);
        return info ? info.styleConfig : null;
    }

    // 重建标注层（样式变化后同步标注外观：点标注色点颜色等）
    function rebuildLabels(info) {
        if (!info.labelField) return;
        const map = MapManager.getMap();
        const wasVisible = info.labelsVisible && info.visible;
        if (wasVisible) map.removeLayer(info.labelLayer);
        const result = createLabelLayer(info.data, info.styleConfig, getEffectiveLabelSettings(info._id));
        info.labelLayer = result.labelLayer;
        if (wasVisible) info.labelLayer.addTo(map);
    }

    // 将当前样式应用到地图图层（面/线 setStyle，点重建图标，标注重建）
    function applyLayerStyle(info) {
        if (typeof info.layer.setStyle === 'function') {
            info.layer.setStyle(createStyleFunction(info.styleConfig));
        }
        restylePoints(info.layer, info.styleConfig);
        rebuildLabels(info);
    }

    // 更新图层样式（部分或全部字段）
    function updateLayerStyle(id, patch) {
        const info = layers.get(id);
        if (!info || !patch) return;
        Object.assign(info.styleConfig, patch);
        applyLayerStyle(info);
        if (id === highlightedId) refreshHighlightOverlay();
        persistStyles();
        UIManager.updateLayerItem(id);
        UIManager.updateLegend();
        UIManager.updateButtonsState();
    }


    // ---------- 样式偏离检测（控制"重置"按钮可用性） ----------

    // 指定图层的样式是否仍为默认值（逐字段比较）
    function isLayerStyleDefault(id) {
        const info = layers.get(id);
        if (!info) return true;
        const defaults = defaultStyle(info.config);
        return Object.keys(defaults).every(key => info.styleConfig[key] === defaults[key]);
    }


    // ---------- 获取信息 ----------
    function getLayerInfo(id) { return layers.get(id) || null; }
    function getAllLayers() { return layers; }
    function getLayersByGroup(group) {
        return new Map([...layers].filter(([, info]) => (info.config.group || '未分组') === group));
    }

    // R109：返回单个图层自身包含的字段（用于每图层标注设置的下拉候选）
    function getLayerFields(id) {
        const info = layers.get(id);
        if (!info || !info.data || !info.data.features) return [];
        const keys = new Set();
        info.data.features.forEach(f => { Object.keys(f.properties || {}).forEach(k => keys.add(k)); });
        return [...keys].sort();
    }


    // R108：获取指定图层的 effective 标注设置（全局默认值 + 该图层覆盖值）
    function getLayerLabelSettings(id) {
        const info = layers.get(id);
        if (!info) return Object.assign({}, labelSettings);
        return getEffectiveLabelSettings(id);
    }

    // R108：设置指定图层的标注外观覆盖（字段 / 文字色 / 扫边 / 字体 / 字号），不影响全局
    function setLayerLabelSettings(id, patch) {
        const info = layers.get(id);
        if (!info || !patch) return;
        let override = labelOverrides.get(id);
        if (!override) { override = {}; labelOverrides.set(id, override); }
        if ('field' in patch) override.field = patch.field;
        if ('textColor' in patch) override.textColor = patch.textColor;
        if ('haloColor' in patch) override.haloColor = patch.haloColor;
        if ('haloWidth' in patch) override.haloWidth = patch.haloWidth;
        if ('textOpacity' in patch) override.textOpacity = patch.textOpacity;
        if ('haloOpacity' in patch) override.haloOpacity = patch.haloOpacity;
        if ('fontFamily' in patch) override.fontFamily = patch.fontFamily;
        if ('fontSize' in patch) override.fontSize = patch.fontSize;
        // 清除空字符串，减少存储噪音
        Object.keys(override).forEach(key => {
            if (override[key] === '' || override[key] === null || override[key] === undefined) delete override[key];
        });
        if (Object.keys(override).length === 0) labelOverrides.delete(id);
        persistLayerLabelOverrides();
        rebuildLabels(info);
    }

    // R108：设置指定图层的标注运行时显隐（不写入 per-layer 持久化，由 UI 即时生效）
    function setLayerLabelsVisible(id, on) {
        const info = layers.get(id);
        if (!info || !info.labelField) return;
        const map = MapManager.getMap();
        info.labelsVisible = !!on;
        if (info.labelsVisible && info.visible && !isDatasetHidden(info.config.group || '未分组')) {
            info.labelLayer.addTo(map);
        } else {
            map.removeLayer(info.labelLayer);
        }
        if (typeof UIManager !== 'undefined' && UIManager.updateLayerItem) UIManager.updateLayerItem(id);
    }

    // R108：切换整个数据集的标注显隐；target = 只要有一个图层显示就全部隐藏，否则全部显示
    function toggleDatasetLabels(name) {
        const groupLayers = getLayersByGroup(name);
        if (groupLayers.size === 0) return;
        const anyVisible = [...groupLayers.values()].some(info => info.labelsVisible);
        const target = !anyVisible;
        groupLayers.forEach(info => setLayerLabelsVisible(info._id, target));
    }


    // R106：地点搜索点击后的「高亮 + 属性弹窗」——以要素真实几何绘制高亮描边并闪烁 3s，
    // 同时弹出该要素的属性（与点击要素一致），而非在中心叠加一个独立点标记。
    function flashFeature(feature, opts) {
        opts = opts || {};
        const map = MapManager.getMap();
        if (!map || !feature) return null;
        const duration = Number(opts.duration) || 3000;
        const accent = '#4f6ef7';
        const overlay = L.geoJSON(feature, {
            style: {
                color: accent,
                weight: 3,
                opacity: 1,
                fillColor: accent,
                fillOpacity: 0.22,
                dashArray: '7 5',
                className: 'place-flash-overlay',
            },
            pointToLayer: (f, latlng) => L.circleMarker(latlng, {
                radius: 9,
                color: accent,
                weight: 3,
                fillColor: accent,
                fillOpacity: 0.3,
                className: 'place-flash-overlay',
            }),
        }).addTo(map);
        try { overlay.bringToFront(); } catch (e) {}

        const props = feature.properties || {};
        const kind = getGeometryKind(feature.geometry);
        const kindIcon = kind === 'point' ? 'fa-location-dot' : kind === 'line' ? 'fa-route' : 'fa-draw-polygon';
        const title = opts.title || getFeatureLabel(feature, opts.labelField) || '要素详情';
        const sub = opts.sub || '';
        const rows = [];
        const seen = new Set(['name', 'title']);
        if (opts.labelField) seen.add(opts.labelField);
        const pushRow = (k, v) => {
            if (seen.has(k)) return;
            seen.add(k);
            if (v === null || v === undefined || String(v).trim() === '') return;
            rows.push(`<div class="feature-popup-row"><span class="feature-popup-key">${escapeHtml(k)}</span><span class="feature-popup-val">${escapeHtml(v)}</span></div>`);
        };
        ['type', 'category', 'address', 'description', 'area', 'length'].forEach(k => pushRow(k, props[k]));
        Object.entries(props).forEach(([k, v]) => pushRow(k, v));
        const html =
            `<div class="feature-popup">` +
                `<div class="feature-popup-header"><span class="feature-popup-icon"><i class="fas ${kindIcon}"></i></span>` +
                `<div class="feature-popup-heading"><div class="feature-popup-title">${escapeHtml(title)}</div>` +
                (sub ? `<div class="feature-popup-sub">${escapeHtml(sub)}</div>` : '') +
                `</div></div>` +
                (rows.length ? `<div class="feature-popup-body">${rows.join('')}</div>` : '') +
            `</div>`;
        overlay.bindPopup(html, { direction: 'top', autoPan: true, autoPanPadding: [24, 24], closeButton: true, minWidth: 220, maxWidth: 300 }).openPopup();

        const timer = setTimeout(() => { try { map.removeLayer(overlay); } catch (e) {} }, duration);
        overlay.on('popupclose', () => { clearTimeout(timer); try { map.removeLayer(overlay); } catch (e) {} });
        return { overlay, timer };
    }

    // R110：提供默认样式/标注的克隆，供「完成后应用」预览模式在「恢复默认」时还原（不直接改地图）
    function getDefaultStyle(id) {
        const info = layers.get(id);
        if (!info) return null;
        return Object.assign({}, defaultStyle(info.config));
    }
    function getDefaultLabelSettings() {
        return Object.assign({}, defaultLabelSettings());
    }

    return {
        loadLayer,
        loadDataset,
        removeDataset,
        finalizeBatchLoad,
        prependNewLayersOnTop,
        setLoading,
        setLoadingListener,
        getLoadedGroupNames,
        setLayerOrder,
        setAllVisibility,
        toggleLayer,
        removeLayer,
        isDatasetHidden,
        setDatasetVisible,
        toggleDatasetVisible,
        showAllDatasets,
        hideAllDatasets,
        zoomToLayer,
        toggleLabels,
        setLayerHighlight,
        clearLayerHighlight,
        getHighlightedLayerId,
        getLayerInfo,
        getLayerStyle,
        getThemeColor,
        updateLayerStyle,
        isLayerStyleDefault,
        getAllLayers,
        getLayersByGroup,
        getLayerFields,
        getLayerLabelSettings,
        setLayerLabelSettings,
        setLayerLabelsVisible,
        toggleDatasetLabels,
        flashFeature,
        filterLayers,
        updateStats,
        getDefaultStyle,
        getDefaultLabelSettings,
    };
})();