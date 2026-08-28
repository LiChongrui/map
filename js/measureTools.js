/**
 * 测量工具 - 测距 / 测面积
 * 左上角工具按钮，点击激活后在地图上打点，双击完成测量，结果展示在控件内。
 */

const MeasureTools = (function() {

    let map = null;
    let mode = null;              // null | 'distance' | 'area'
    let points = [];
    let measureLayers = [];       // 当前正在绘制的测量（实时预览/编辑中）
    let committedLayers = [];     // R107：已完成的测量（双击结束后烘焙保留，点「清除测量」前持续叠加显示）
    let controlEl = null;
    let toolbarContainer = null;
    let finished = false;         // 已完成测量（图形保留，等待清除）

    const DISTANCE_COLOR = '#4f6ef7';
    const AREA_COLOR = '#10b981';
    const POINT_COLOR = '#4f6ef7';

    // ---------- 初始化 ----------
    // R83：支持传入外部工具栏容器；若提供，则按钮渲染到该容器，不创建 Leaflet control
    function init(mapInstance, container) {
        if (!mapInstance || map) return;
        map = mapInstance;
        if (container) {
            toolbarContainer = container;
            bindToolbarButtons();
        } else {
            const control = L.control({ position: 'topright' });
            control.onAdd = function() {
                const c = L.DomUtil.create('div', 'leaflet-control measure-control');
                c.setAttribute('role', 'group');
                c.setAttribute('aria-label', '测量工具');
                c.innerHTML = measureButtonsHTML();
                controlEl = c;
                bindButtons(c);
                L.DomEvent.disableClickPropagation(c);
                return c;
            };
            control.addTo(map);
        }

        map.on('click', onMapClick);
        map.on('dblclick', onMapDblClick);
        map.on('mousemove', onMapMove);
    }

    function measureButtonsHTML() {
        return `
            <button type="button" class="measure-btn map-tool-btn" data-tool="distance" data-tooltip="测距" aria-label="测距"><i class="fas fa-ruler-combined"></i></button>
            <button type="button" class="measure-btn map-tool-btn" data-tool="area" data-tooltip="测面积" aria-label="测面积"><i class="fas fa-draw-polygon"></i></button>
            <button type="button" class="measure-btn map-tool-btn" data-tool="clear" data-tooltip="清除测量" aria-label="清除测量"><i class="fas fa-eraser"></i></button>
        `;
    }

    function bindButtons(root) {
        root.querySelectorAll('.measure-btn').forEach(btn => {
            btn.addEventListener('click', () => onToolClick(btn.dataset.tool));
        });
    }

    function bindToolbarButtons() {
        if (!toolbarContainer) return;
        toolbarContainer.querySelectorAll('.measure-btn').forEach(btn => {
            btn.addEventListener('click', () => onToolClick(btn.dataset.tool));
        });
    }

    // ---------- 工具按钮 ----------
    // ---------- 测量内容变化通知（R93）----------
    // 清除测量按钮依赖「地图上是否有测量内容」决定可用态；
    // 通过 document 自定义事件广播，UIManager 监听后切换按钮禁用态。
    function notifyChange() {
        document.dispatchEvent(new CustomEvent('lyc:measurechange', {
            detail: { count: committedLayers.length + measureLayers.length },
        }));
    }

    function onToolClick(tool) {
        if (tool === 'clear') {
            clearAll();
            return;
        }
        if (mode === tool) {
            deactivate();
            return;
        }
        activate(tool);
    }

    function activate(newMode) {
        deactivate();
        mode = newMode;
        points = [];
        finished = false;
        // 测量期间禁用双击缩放：双击用于「结束测量」
        if (map.doubleClickZoom) map.doubleClickZoom.disable();
        // 测量期间禁用地图上其他点击交互（要素弹窗/高亮等）：
        // 地图容器加 .measuring，CSS 里把 .leaflet-interactive 设为 pointer-events:none
        map.getContainer().classList.add('measuring');
        updateButtons();
        map.getContainer().style.cursor = 'crosshair';
        notifyChange();
    }

    function deactivate() {
        mode = null;
        if (map.doubleClickZoom) map.doubleClickZoom.enable();
        map.getContainer().classList.remove('measuring');
        map.getContainer().style.cursor = '';
        // 清理「进行中」的临时图形（已完成的测量在 committedLayers 中保留）
        clearMeasureLayers();
        updateButtons();
        notifyChange();
    }

    function clearAll() {
        deactivate();
        points = [];
        finished = false;
        clearMeasureLayers();
        clearCommittedLayers();
        notifyChange();
    }

    // ---------- 地图交互 ----------
    function onMapClick(e) {
        if (!mode) return;
        points.push(e.latlng);
        redraw();
    }

    function onMapDblClick() {
        if (!mode) return;
        finishMeasure();
    }

    // 悬停实时预览最后一段
    function onMapMove(e) {
        if (!mode || points.length === 0) return;
        const pts = [...points, e.latlng];
        if (mode === 'distance' && pts.length >= 2) {
            const d = segmentLength(pts[pts.length - 2], e.latlng);
            previewLine(pts, d, 'distance');
        } else if (mode === 'area' && points.length >= 2) {
            previewLine(pts, null, 'area');
        }
    }

    function finishMeasure() {
        // 结果已实时标注在地图上（分段距离标签 / 多边形中心面积标签），无需结果条
        finished = true;
        // R107：将本次测量烘焙为「已完成」图层，保留在地图上（不清理上次测量）；
        //       仅当点击「清除测量」时才整体移除。后续再测一次会与本次叠加显示。
        committedLayers = committedLayers.concat(measureLayers);
        measureLayers = [];
        deactivate();
    }

    // ---------- 计算 ----------
    function segmentLength(a, b) {
        return map.distance(a, b);
    }

    // 球面多边形面积（等距圆柱投影近似，适合中小范围）
    function polygonArea(pts) {
        const R = 6371000;
        const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length * Math.PI / 180;
        const cosLat = Math.cos(lat0);
        const xy = pts.map(p => ({
            x: p.lng * Math.PI / 180 * R * cosLat,
            y: p.lat * Math.PI / 180 * R,
        }));
        let area = 0;
        for (let i = 0; i < xy.length; i++) {
            const j = (i + 1) % xy.length;
            area += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
        }
        return Math.abs(area) / 2;
    }

    // 多边形中心（顶点平均，适用于凸多边形近似）
    function polygonCenter(pts) {
        if (!pts.length) return null;
        return L.latLng(
            pts.reduce((s, p) => s + p.lat, 0) / pts.length,
            pts.reduce((s, p) => s + p.lng, 0) / pts.length
        );
    }

    function formatLength(m) {
        return m >= 1000 ? (m / 1000).toFixed(2) + ' 公里' : Math.round(m) + ' 米';
    }

    function formatArea(m2) {
        if (m2 >= 1000000) return (m2 / 1000000).toFixed(2) + ' 平方公里';
        if (m2 >= 10000) return (m2 / 10000).toFixed(2) + ' 公顷';
        return Math.round(m2) + ' 平方米';
    }

    // ---------- 渲染 ----------
    function redraw() {
        clearMeasureLayers();
        if (points.length === 0) {
            notifyChange();
            return;
        }

        points.forEach(ll => {
            measureLayers.push(L.marker(ll, {
                interactive: false,
                icon: L.divIcon({
                    className: 'measure-point',
                    html: '<span></span>',
                    iconSize: [10, 10],
                    iconAnchor: [5, 5],
                }),
            }).addTo(map));
        });

        if (mode === 'distance' && points.length >= 2) {
            const line = L.polyline(points, { color: DISTANCE_COLOR, weight: 2, opacity: 0.9, interactive: false });
            measureLayers.push(line.addTo(map));
            // 分段累计距离标签
            let acc = 0;
            points.slice(1).forEach((ll, i) => {
                acc += map.distance(points[i], ll);
                measureLayers.push(L.marker(ll, {
                    interactive: false,
                    icon: L.divIcon({
                        className: 'measure-label',
                        html: `<span>${formatLength(acc)}</span>`,
                        iconSize: [0, 0],
                        iconAnchor: [0, 0],
                    }),
                }).addTo(map));
            });
        } else if (mode === 'area' && points.length >= 3) {
            const poly = L.polygon(points, {
                color: AREA_COLOR, weight: 2, opacity: 0.9, fillOpacity: 0.15, interactive: false,
            });
            // 实时面积：≥3 个点即计算，结果随多边形中心位置与面积同步更新（每次 redraw 重建）。
            // 用 Leaflet 原生 tooltip direction:'center' ——中心由 Leaflet 精确计算，随多边形自动贴合
            poly.bindTooltip(formatArea(polygonArea(points)), {
                permanent: true,
                direction: 'center',
                className: 'measure-area-tooltip',
                opacity: 1,
            });
            measureLayers.push(poly.addTo(map));
        }
        notifyChange();
    }

    // 悬停预览：虚线示意下一点
    function previewLine(pts, segLen, kind) {
        if (pts.length < 2) return;
        clearMeasureLayers();
        redraw();
        const color = kind === 'distance' ? DISTANCE_COLOR : AREA_COLOR;
        const dash = L.polyline(pts, {
            color, weight: 1.5, opacity: 0.7, dashArray: '6 6', interactive: false,
        });
        measureLayers.push(dash.addTo(map));
        if (kind === 'distance' && segLen !== null) {
            const last = pts[pts.length - 1];
            measureLayers.push(L.marker(last, {
                interactive: false,
                icon: L.divIcon({
                    className: 'measure-label',
                    html: `<span>${formatLength(segLen)}</span>`,
                    iconSize: [0, 0],
                    iconAnchor: [0, 0],
                    }),
                }).addTo(map));
        }
        notifyChange();
    }

    function clearMeasureLayers() {
        measureLayers.forEach(layer => map.removeLayer(layer));
        measureLayers = [];
    }

    // R107：仅移除「已完成」的测量图层（进行中的图形由 clearMeasureLayers 处理）
    function clearCommittedLayers() {
        committedLayers.forEach(layer => map.removeLayer(layer));
        committedLayers = [];
    }

    function updateButtons() {
        const root = toolbarContainer || controlEl;
        if (!root) return;
        root.querySelectorAll('.measure-btn').forEach(btn => {
            btn.classList.toggle('active', mode === btn.dataset.tool);
        });
    }

    // ---------- 公开 API ----------
    return {
        init,
        clear: clearAll,
        onToolClick,
        getMode: () => mode,
    };

})();
