/**
 * 图层管理 - 支持多GeoJSON独立控制
 */

const LayerManager = (function() {
    const layers = new Map();

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

    // 按 savedOrder 重排 layers（未记录的图层按原有相对顺序追加在后）
    function applySavedOrder() {
        const savedOrder = readSavedOrder();
        if (!savedOrder) return;
        const currentLayers = new Map(layers);
        layers.clear();
        savedOrder.forEach(id => {
            if (currentLayers.has(id)) layers.set(id, currentLayers.get(id));
        });
        currentLayers.forEach((info, id) => {
            if (!layers.has(id)) layers.set(id, info);
        });
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

    // 多边形内部标注点：polylabel 简化版（网格采样 + 细分迭代），
    // 返回「离所有边界最远」的内部点——对凹多边形 / 带洞多边形也保证在多边形内部中心。
    // 局部小范围用等距圆柱近似（lng 乘 cos(lat0) 平面化，与面积计算一致）
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
        const cosLat = Math.cos((minY + maxY) / 2 * Math.PI / 180) || 1;
        const toXY = c => [c[0] * cosLat, c[1]];
        const outerXY = outerRings.map(r => r.map(toXY));
        const holesXY = holes.map(r => r.map(toXY));
        const width = (maxX - minX) * cosLat || 1;
        const height = maxY - minY || 1;

        // 射线法：点是否在环内（平面化坐标）
        const inRing = (x, y, ring) => {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
            }
            return inside;
        };
        const inside = (x, y) =>
            outerXY.some(r => inRing(x, y, r)) && !holesXY.some(r => inRing(x, y, r));

        const distToSeg = (x, y, ax, ay, bx, by) => {
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
            return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        };
        const distToBoundary = (x, y) => {
            let min = Infinity;
            const all = outerXY.concat(holesXY);
            for (const ring of all) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const d = distToSeg(x, y, ring[i][0], ring[i][1], ring[j][0], ring[j][1]);
                    if (d < min) min = d;
                }
            }
            return min;
        };

        // 网格采样（24×24），取内部「离边界最远」的点
        const stepX = width / 24, stepY = height / 24;
        let bestX = null, bestY = null, bestDist = -1;
        for (let i = 0; i <= 24; i++) {
            for (let j = 0; j <= 24; j++) {
                const x = minX * cosLat + i * stepX;
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
        return L.latLng(bestY, bestX / cosLat);
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
                return polygonInteriorPoint([coordinates]);

            case 'MultiPolygon':
                return polygonInteriorPoint(coordinates);

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

    // 标注字段：取数据的第一个属性字段（不固定使用 name），无属性数据返回 null
    function getLabelField(data) {
        for (const feature of (data.features || [])) {
            const keys = Object.keys(feature.properties || {});
            if (keys.length > 0) return keys[0];
        }
        return null;
    }

    // 要素标注文本：标注字段值 trim；空值返回空字符串（该要素不显示标注）
    function getFeatureLabel(feature, labelField) {
        if (!labelField) return '';
        return String(feature.properties?.[labelField] ?? '').trim();
    }

    function createLabelLayer(data, styleConfig) {
        const labelLayer = L.layerGroup();
        // 标注默认取数据的第一个属性字段（而非固定 name 字段）
        const labelField = getLabelField(data);
        data.features.forEach(feature => {
            // trim 过滤纯空白值（数据中存在单个空格的标注值，会渲染出空标注）
            const name = getFeatureLabel(feature, labelField);
            if (!name) return;
            const geometry = feature.geometry;
            if (!geometry) return;
            const position = getLabelPosition(geometry);
            if (!position) return;

            // 标注主题色：与图层主色一致（面=填充色/线=线色/点=点色），随样式配置实时变化
            const kind = getGeometryKind(geometry) || 'polygon';
            const labelColor = getThemeColor(styleConfig, kind) || '#334155';
            // 统一归类到 point / linestring / polygon 三个样式类，Multi* 也能正确居中
            const geomClass = kind === 'point' ? 'point' : (kind === 'line' ? 'linestring' : 'polygon');

            // 线要素：标注始终横向排列（不随线走向旋转、不竖排），
            // 仅沿法线方向偏移到线旁（不压线）。Mercator 投影保角，屏幕方向角不随缩放/平移变化
            let vertical = false;
            let offsetAttr = '';
            if (kind === 'line') {
                const centerInfo = lineCenter(geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates);
                if (centerInfo) {
                    const lineWidth = Math.max(0.5, Number(styleConfig.lineWidth) || 2.5);
                    const normalGap = Math.max(7, lineWidth / 2 + 5);
                    const rad = centerInfo.angle * Math.PI / 180;
                    // 法线朝屏幕上方一侧（水平线时标注在线上方），文字保持正向横向排列
                    const dx = Math.round(-Math.sin(rad) * normalGap * 10) / 10;
                    const dy = Math.round(-Math.cos(rad) * normalGap * 10) / 10;
                    offsetAttr = `;--label-dx:${dx}px;--label-dy:${dy}px`;
                }
            }

            // 点要素：标注抬升量随点大小/边线变化，紧贴圆点上方（间隙为 0）
            if (kind === 'point') {
                const size = Math.max(4, Number(styleConfig.pointSize) || 10);
                const stroke = Math.max(0, Number(styleConfig.pointStrokeWidth) || 0);
                offsetAttr = `;--label-offset:${Math.round(size / 2 + stroke)}px`;
            }

            const labelClass = `map-feature-label map-feature-label--${geomClass}${vertical ? ' map-feature-label--vertical' : ''}`;
            // 颜色经 CSS 变量传递：暗色主题下由 CSS 提亮，保证在底衬上的可读性
            const styleAttr = `--label-color:${escapeHtml(labelColor)}${offsetAttr}`;
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
                const { labelLayer, labelField } = createLabelLayer(data, styleConfig);

                layerInfo.layer = geoLayer;
                layerInfo.labelLayer = labelLayer;
                layerInfo.labelField = labelField;
                layerInfo.labelsVisible = false;

                layers.set(id, layerInfo);

                if (visible) {
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
    // 加载指定数据集的全部图层（已加载的跳过），加载后应用保存的图层顺序并重设地图叠加次序。
    // 返回 { loaded, failed }；自定义样式保存在 localStorage，重新添加数据集后自动恢复
    function loadDataset(name) {
        const dataset = DataScanner.getDataset(name);
        if (!dataset) return Promise.resolve({ loaded: 0, failed: 0 });

        const pending = dataset.sources.filter(source => !layers.has(source.id));
        if (pending.length === 0) return Promise.resolve({ loaded: 0, failed: 0 });

        return Promise.all(pending.map(source => loadLayer(source))).then(() => {
            // 应用拖拽保存的顺序（新数据集图层按来源顺序追加在末尾），并按最终顺序重设叠加次序
            applySavedOrder();
            // 列表越靠上 = 绘制层级越高（reapplyLayerOrder 逆序移动 SVG path）
            reapplyLayerOrder(MapManager.getMap());

            const loaded = pending.filter(source => layers.has(source.id)).length;
            const failed = pending.length - loaded;
            UIManager.updateLayerPanel();
            UIManager.updateLegend();
            updateStats();
            UIManager.updateButtonsState(layers.size > 0);
            return { loaded, failed };
        });
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
            if (info.visible !== visible) {
                info.visible = visible;
                if (visible) {
                    map.addLayer(info.layer);
                    if (info.labelsVisible) info.labelLayer.addTo(map);
                } else {
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

        if (info.visible) {
            map.removeLayer(info.layer);
            if (info.labelsVisible) map.removeLayer(info.labelLayer);
            info.visible = false;
            // 高亮中的图层被隐藏时自动取消高亮
            if (highlightedId === id) clearLayerHighlight();
        } else {
            map.addLayer(info.layer);
            if (info.labelsVisible) info.labelLayer.addTo(map);
            info.visible = true;
        }

        // 只更新该条目的 UI，避免全量重建列表；同时刷新工具栏按钮可用态
        UIManager.updateLayerItem(id);
        UIManager.updateLegend();
        UIManager.updateButtonsState();
        updateStats();
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

    // 高亮指定图层（覆盖式：先清除已有高亮；图层需可见）
    function setLayerHighlight(id) {
        const info = layers.get(id);
        if (!info || !info.visible) return false;
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
            groups.add(info.config.group || '未分组');
            if (info.visible) visibleCount += 1;
        });
        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setStat('statDatasets', groups.size);
        setStat('statLayers', layers.size);
        setStat('statVisible', visibleCount);
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
        const result = createLabelLayer(info.data, info.styleConfig);
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

    // 恢复默认样式
    function resetLayerStyle(id) {
        const info = layers.get(id);
        if (!info) return;
        info.styleConfig = defaultStyle(info.config);
        applyLayerStyle(info);
        if (id === highlightedId) refreshHighlightOverlay();
        persistStyles();
        UIManager.updateLayerItem(id);
        UIManager.updateLegend();
        UIManager.updateButtonsState();
    }

    // 重置所有图层为默认样式（批量，一次持久化）
    function resetAllStyles() {
        layers.forEach((info) => {
            info.styleConfig = defaultStyle(info.config);
            applyLayerStyle(info);
        });
        refreshHighlightOverlay();
        persistStyles();
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        UIManager.updateButtonsState();
    }

    // ---------- 按数据集重置样式 ----------
    // 重置指定数据集内全部图层为默认样式，返回重置的图层数
    function resetGroupStyles(name) {
        const groupLayers = getLayersByGroup(name);
        let count = 0;
        groupLayers.forEach(info => {
            info.styleConfig = defaultStyle(info.config);
            applyLayerStyle(info);
            if (highlightedId !== null && layers.get(highlightedId) === info) refreshHighlightOverlay();
            count += 1;
        });
        persistStyles();
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        UIManager.updateButtonsState();
        return count;
    }

    // 指定数据集内是否存在样式偏离默认值的图层（分组头「重置样式」按钮可用性）
    function groupHasCustomStyles(name) {
        for (const id of getLayersByGroup(name).keys()) {
            if (!isLayerStyleDefault(id)) return true;
        }
        return false;
    }

    // ---------- 样式偏离检测（控制"重置"按钮可用性） ----------

    // 指定图层的样式是否仍为默认值（逐字段比较）
    function isLayerStyleDefault(id) {
        const info = layers.get(id);
        if (!info) return true;
        const defaults = defaultStyle(info.config);
        return Object.keys(defaults).every(key => info.styleConfig[key] === defaults[key]);
    }

    // 是否存在任一图层样式偏离默认值（决定"重置所有样式"按钮是否可用）
    function hasCustomStyles() {
        for (const id of layers.keys()) {
            if (!isLayerStyleDefault(id)) return true;
        }
        return false;
    }

    // ---------- 获取信息 ----------
    function getLayerInfo(id) { return layers.get(id) || null; }
    function getAllLayers() { return layers; }
    function getLayersByGroup(group) {
        return new Map([...layers].filter(([, info]) => (info.config.group || '未分组') === group));
    }

    return {
        loadLayer,
        loadDataset,
        removeDataset,
        getLoadedGroupNames,
        setLayerOrder,
        setAllVisibility,
        toggleLayer,
        removeLayer,
        zoomToLayer,
        toggleLabels,
        setLayerHighlight,
        clearLayerHighlight,
        getHighlightedLayerId,
        getLayerInfo,
        getLayerStyle,
        getThemeColor,
        updateLayerStyle,
        resetLayerStyle,
        resetAllStyles,
        resetGroupStyles,
        groupHasCustomStyles,
        isLayerStyleDefault,
        hasCustomStyles,
        getAllLayers,
        getLayersByGroup,
        filterLayers,
        updateStats,
    };
})();