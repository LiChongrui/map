/**
 * 测量工具 - 测距 / 测面积
 * 左上角工具按钮，点击激活后在地图上打点，双击完成测量，结果展示在控件内。
 */

const MeasureTools = (function() {

    let map = null;
    let mode = null;              // null | 'distance' | 'area'
    let points = [];
    let measureLayers = [];
    let controlEl = null;
    let finished = false;         // 已完成测量（图形保留，等待清除）

    const DISTANCE_COLOR = '#4f6ef7';
    const AREA_COLOR = '#10b981';
    const POINT_COLOR = '#4f6ef7';

    // ---------- 初始化 ----------
    function init(mapInstance) {
        if (!mapInstance || map) return;
        map = mapInstance;

        const control = L.control({ position: 'topleft' });
        control.onAdd = function() {
            const container = L.DomUtil.create('div', 'leaflet-control measure-control');
            container.setAttribute('role', 'group');
            container.setAttribute('aria-label', '测量工具');
            container.innerHTML = `
                <button type="button" class="measure-btn" data-tool="distance" data-tooltip="测距" aria-label="测距"><i class="fas fa-ruler-combined"></i></button>
                <button type="button" class="measure-btn" data-tool="area" data-tooltip="测面积" aria-label="测面积"><i class="fas fa-draw-polygon"></i></button>
                <button type="button" class="measure-btn" data-tool="clear" data-tooltip="清除测量" aria-label="清除测量"><i class="fas fa-eraser"></i></button>
            `;
            controlEl = container;
            container.querySelectorAll('.measure-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    onToolClick(btn.dataset.tool);
                });
            });
            // 阻止测量控件点击冒泡到地图
            L.DomEvent.disableClickPropagation(container);
            return container;
        };
        control.addTo(map);

        map.on('click', onMapClick);
        map.on('dblclick', onMapDblClick);
        map.on('mousemove', onMapMove);
    }

    // ---------- 工具按钮 ----------
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
    }

    function deactivate() {
        mode = null;
        if (map.doubleClickZoom) map.doubleClickZoom.enable();
        map.getContainer().classList.remove('measuring');
        map.getContainer().style.cursor = '';
        updateButtons();
    }

    function clearAll() {
        deactivate();
        points = [];
        finished = false;
        clearMeasureLayers();
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
        if (points.length === 0) return;

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
    }

    function clearMeasureLayers() {
        measureLayers.forEach(layer => map.removeLayer(layer));
        measureLayers = [];
    }

    function updateButtons() {
        if (!controlEl) return;
        controlEl.querySelectorAll('.measure-btn').forEach(btn => {
            btn.classList.toggle('active', mode === btn.dataset.tool);
        });
    }

    // ---------- 公开 API ----------
    return {
        init,
        clear: clearAll,
    };

})();
