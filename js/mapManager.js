/**
 * 地图核心管理
 */

const MapManager = (function() {
    let mapInstance = null;
    let currentBaseLayer = null;
    let baseLayerLabelEl = null;
    let baseLayerControlElement = null;
    const baseLayerControls = {};

    function init(containerId = 'map') {
        if (mapInstance) return mapInstance;

        const { center, zoom, minZoom, maxZoom } = CONFIG.map;

        mapInstance = L.map(containerId, {
            center,
            zoom,
            minZoom,
            maxZoom,
            // zoomSnap: 0 —— 关键：Leaflet getBoundsZoom 对 fitBounds 结果按 zoomSnap 取整
            // （默认 1 → floor 到整数，如 13.71 → 13，内容只占 ~42% 屏幕）。
            // 设为 0 后 fitBounds 可精确到浮点 zoom，内容真正填满可用区域
            zoomSnap: 0,
            zoomControl: false,
            fadeAnimation: true,
            attributionControl: true,
        });

        // 自定义缩放控件（R88）：脱离 Leaflet 默认 control，改为右下角「上层放大缩小、下层经纬度/比例尺/提供商」布局
        addZoomControl();
        // 让缩放控件始终浮在底部信息行（经纬度/比例尺/提供商）之上，需按该行实际高度定位
        repositionBottomHud();
        mapInstance.on('zoomend', updateZoomButtons);

        L.control.scale({
            position: 'bottomright',
            metric: true,
            imperial: false
        }).addTo(mapInstance);

        // R69：鼠标位置经纬度坐标显示（右下角，与比例尺/版权单行排列）
        addCoordinateControl();

        addBaseLayers();
        // R107：底图切换改为右上角图标按钮（#basemapToggle，见 uiManager.initBaseLayerToolMenu），
        // 不再动态创建顶部中央药丸，此处不再调用 addBaseLayerControl()
        mapInstance.getContainer().querySelectorAll('[title]').forEach(element => {
            element.removeAttribute('title');
        });

        window.addEventListener('resize', () => {
            mapInstance.invalidateSize();
            repositionBottomHud();
        });

        // 信息行（经纬度/比例尺/提供商）高度在瓦片与版权渲染后才会稳定，延迟再定位一次缩放控件
        setTimeout(repositionBottomHud, 400);
        mapInstance.on('zoomend', repositionBottomHud);

        return mapInstance;
    }

    // 空白底图：无瓦片的空图层（显示地图容器背景色）
    const BlankLayer = L.Layer.extend({
        onAdd: function() {},
        onRemove: function() {},
    });

    // R69：鼠标位置经纬度坐标控件（右下角，mousemove 更新，移出地图显示占位）
    function addCoordinateControl() {
        const coordControl = L.control({ position: 'bottomright' });
        coordControl.onAdd = function() {
            const el = L.DomUtil.create('div', 'leaflet-control coordinate-control');
            el.textContent = '—';
            mapInstance.on('mousemove', e => {
                // 统一「经度在前、纬度在后」，不显示中文字段名
                el.textContent = `${e.latlng.lng.toFixed(4)}°, ${e.latlng.lat.toFixed(4)}°`;
            });
            mapInstance.on('mouseout', () => {
                el.textContent = '—';
            });
            L.DomEvent.disableClickPropagation(el);
            return el;
        };
        coordControl.addTo(mapInstance);
    }

    // R110：Esri Sentinel-2 Views 是「每日更新最新无云影像」的实时服务，但仅以 ArcGIS
    // ImageServer（exportImage）形式提供，非缓存 XYZ 瓦片。此处按每瓦片 bbox 动态拼接
    // exportImage 请求，得到一个真正「实时自动更新」的哨兵2 底图。
    function createEsriExportLayer(baseUrl, options) {
        const EsriExport = L.TileLayer.extend({
            getTileUrl: function (coords) {
                const size = 256;
                const zoom = coords.z;
                const resolution = (2 * Math.PI * 6378137) / (size * Math.pow(2, zoom));
                const originX = -20037508.342789244;
                const originY = 20037508.342789244;
                const minX = originX + coords.x * size * resolution;
                const maxX = minX + size * resolution;
                const maxY = originY - coords.y * size * resolution;
                const minY = maxY - size * resolution;
                const bbox = [minX.toFixed(2), minY.toFixed(2), maxX.toFixed(2), maxY.toFixed(2)].join(',');
                return baseUrl + '/exportImage?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=' + size + ',' + size + '&format=jpgpng&f=image';
            }
        });
        return new EsriExport('', options || {});
    }

    function addBaseLayers() {
        for (const [name, layerConfig] of Object.entries(CONFIG.baseLayers)) {
            let layer;
            if (layerConfig.type === 'esriExport') {
                layer = createEsriExportLayer(layerConfig.url, layerConfig.options);
            } else if (layerConfig.url) {
                layer = L.tileLayer(layerConfig.url, layerConfig.options);
            } else {
                layer = new BlankLayer();
            }
            baseLayerControls[name] = layer;

            if (name === CONFIG.defaultBaseLayer) {
                layer.addTo(mapInstance);
                currentBaseLayer = name;
            }
        }
        updateBaseLayerLabel();
        refreshTilesThemeFilter(); // R95：初始底图按当前主题套滤镜（暗色恢复启动时）
    }

    function updateBaseLayerControl() {
        updateBaseLayerLabel();
    }

    // 地图顶部中央「当前底图」可点击控件：底图信息（名称）与切换按钮融合为同一个药丸，
    // 点击展开 #baseLayerToolMenu 进行切换（R86：从底部左侧移到顶部中央；作为 .map-area 直接子元素，
    // 与 #map 平级，点击不会触发地图拖拽/平移；mousedown 亦阻止冒泡）
    function addBaseLayerControl() {
        const mapArea = document.querySelector('.map-area');
        const el = document.createElement('button');
        el.className = 'basemap-pill';
        el.id = 'basemapPill';
        el.type = 'button';
        el.setAttribute('aria-label', '切换底图');
        el.setAttribute('aria-haspopup', 'menu');
        el.dataset.tooltip = '切换底图';
        // 阻止地图平移：药丸在 #map 之外，mousedown 不再冒泡到地图容器
        el.addEventListener('mousedown', (e) => e.stopPropagation());
        el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        baseLayerLabelEl = el;
        updateBaseLayerLabel();
        if (mapArea) {
            mapArea.appendChild(el);
        } else {
            mapInstance.getContainer().appendChild(el);
        }
        positionBasemapPill();
    }

    // R88：自定义缩放控件（独立于 Leaflet 默认 control）。按钮浮于 .map-area 右下角「上层」，
    // 位于底部信息行（经纬度/比例尺/提供商）之上；具体位置由 repositionBottomHud 动态计算。
    let zoomControlEl = null;
    function addZoomControl() {
        const mapArea = document.querySelector('.map-area');
        const el = document.createElement('div');
        el.className = 'zoom-control';
        el.id = 'zoomControl';
        el.innerHTML =
            '<button type="button" class="zoom-btn zoom-in" id="zoomInBtn" data-tooltip="放大地图" aria-label="放大地图"><i class="fas fa-plus"></i></button>' +
            '<button type="button" class="zoom-btn zoom-out" id="zoomOutBtn" data-tooltip="缩小地图" aria-label="缩小地图"><i class="fas fa-minus"></i></button>';
        // 阻止地图平移：控件在 #map 之外，mousedown 不再冒泡到地图容器
        el.addEventListener('mousedown', e => e.stopPropagation());
        el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
        zoomControlEl = el;
        if (mapArea) mapArea.appendChild(el); else mapInstance.getContainer().appendChild(el);
        el.querySelector('.zoom-in').addEventListener('click', () => mapInstance.zoomIn());
        el.querySelector('.zoom-out').addEventListener('click', () => mapInstance.zoomOut());
        updateZoomButtons();
    }

    // 底部信息行（经纬度/比例尺/提供商）高度随内容变化，缩放控件需浮在其上方；
    // 读取该 Leaflet 容器实际高度，把缩放控件 bottom 设为 行高 + 间距。
    function repositionBottomHud() {
        if (!zoomControlEl) return;
        const info = document.querySelector('.leaflet-bottom.leaflet-right');
        if (!info) return;
        const h = info.offsetHeight || 40;
        zoomControlEl.style.bottom = (h + 8) + 'px';   // R89：缩小放大与底部信息行间距收紧
    }

    function updateZoomButtons() {
        if (!zoomControlEl) return;
        const z = mapInstance.getZoom();
        const { minZoom, maxZoom } = CONFIG.map;
        const inBtn = zoomControlEl.querySelector('.zoom-in');
        const outBtn = zoomControlEl.querySelector('.zoom-out');
        if (inBtn) inBtn.disabled = z >= maxZoom;
        if (outBtn) outBtn.disabled = z <= minZoom;
    }

    function updateBaseLayerLabel() {
        if (!baseLayerLabelEl) return;
        baseLayerLabelEl.innerHTML = '';
        const icon = document.createElement('i');
        icon.className = 'fas fa-map';
        const span = document.createElement('span');
        span.className = 'basemap-pill-name';
        span.textContent = currentBaseLayer || '';
        const chev = document.createElement('i');
        chev.className = 'fas fa-chevron-down basemap-pill-chevron';
        baseLayerLabelEl.appendChild(icon);
        baseLayerLabelEl.appendChild(span);
        baseLayerLabelEl.appendChild(chev);
    }

    function switchBaseLayer(name) {
        const target = baseLayerControls[name];
        if (!target || name === currentBaseLayer) return;
        const old = currentBaseLayer ? baseLayerControls[currentBaseLayer] : null;
        currentBaseLayer = name;
        updateBaseLayerControl();

        if (!old) { target.addTo(mapInstance); refreshTilesThemeFilter(); return; } // R95

        // R94：先叠上新底图、等其加载完成后再移除旧底图。
        // 旧逻辑「先移除旧、再加新」在暗色主题下会先露出写死的浅色地图底色（#e5e3df），
        // 新瓦片慢时亮色残块可持续数秒——即用户反馈的「切换主题时颜色不正常」。
        // 新 TileLayer 后加入、DOM 在上，加载期间旧底图继续垫底，视觉平滑无闪烁。
        target.addTo(mapInstance);
        refreshTilesThemeFilter(); // R95：新层入图即按主题刷滤镜（过渡期旧层一并处理）

        // 目标层无需等待（瓦片已缓存 / 非瓦片图层）：立即移除旧底图
        if (typeof target.isLoading !== 'function' || !target.isLoading()) {
            mapInstance.removeLayer(old);
            return;
        }

        // 加载完成 → 移除旧底图；仅当「旧底图不是当前目标」时才动手，
        // 快速连切时旧回调会自动失效（旧底图可能已被重新选为当前层）
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (old !== baseLayerControls[currentBaseLayer] && mapInstance.hasLayer(old)) {
                mapInstance.removeLayer(old);
            }
        };
        target.once('load', finish);
        // 兜底：慢网 8 秒后强制移除，避免新旧底图长期叠加
        setTimeout(finish, 8000);
    }

    function getMap() {
        if (!mapInstance) throw new Error('地图未初始化');
        return mapInstance;
    }

    function fitBounds(bounds, options = { padding: [32, 32] }) {
        if (!mapInstance || !bounds || !bounds.isValid()) return;
        // R90：退化边界（多点重合 / 单点 / 零面积）若直接 fitBounds 会被 Leaflet 拉到 maxZoom，
        // 表现为「缩放到一个点」；改为在该中心以合理级别定视，避免过曝式放大。
        const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
        const degenerate = (ne.lat - sw.lat < 1e-5) && (ne.lng - sw.lng < 1e-5);
        if (degenerate) {
            mapInstance.setView(bounds.getCenter(), Math.min(CONFIG.map.maxZoom, 14));
            return;
        }
        // 归一化基础 padding（支持 [v, h] 数组或单一数字）
        const base = Array.isArray(options.padding) ? options.padding
            : (typeof options.padding === 'number' ? [options.padding, options.padding] : [32, 32]);
        const baseV = base[0], baseH = base[1];
        // 基础 padding 均分到四边（TL/BR 各一半）——关键修正（R54）：
        // Leaflet 把 bounds 居中放在「paddingTopLeft → size - paddingBottomRight」的可用区域内。
        // 若把全部基础 padding 放 TL、BR 为 0（旧实现），无遮挡时可用区域 = (base, base) → (W, H)，
        // 内容右下角会正好顶住容器右/底边界（#map 是 fixed 占满视口，即浏览器边界）。
        // 均分后可用区域 = (base/2, base/2) → (W - base/2, H - base/2)，内容四周均匀留白；
        // 且有效区域尺寸 W - TL.x - BR.x = W - base 不变 → 缩放级别与旧实现完全一致（不回归 R53）。
        const halfV = baseV / 2, halfH = baseH / 2;
        // 图层面板/侧边栏遮挡避让：R83 后桌面端侧边栏不覆盖地图（map-area 已避开），
        // 只需处理移动端侧边栏作为左侧抽屉打开时的左让位，以及底部条等特殊情况。
        let extraLeft = 0, extraRight = 0, extraBottom = 0;
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('sidebar--collapsed')) {
            const rect = sidebar.getBoundingClientRect();
            const mapRect = mapInstance.getContainer().getBoundingClientRect();
            const overlapW = Math.min(rect.right, mapRect.right) - Math.max(rect.left, mapRect.left);
            const overlapH = Math.min(rect.bottom, mapRect.bottom) - Math.max(rect.top, mapRect.top);
            if (overlapW > 0 && overlapH > 0) {
                const coverW = overlapW / mapRect.width;
                const coverH = overlapH / mapRect.height;
                if (coverW > 0.5 && coverH < coverW - 0.2) {
                    extraBottom = overlapH + 16; // 底部宽条
                } else if (rect.left <= mapRect.left + 2 && coverH > 0.5) {
                    extraLeft = overlapW + 16;   // 左侧高条（移动端抽屉）
                } else if (rect.right >= mapRect.right - 2 && coverH > 0.5) {
                    extraRight = overlapW + 16;  // 右侧高条（兜底）
                }
            }
        }
        // 注意：paddingTopLeft/paddingBottomRight 是 Point(x, y)，必须用 L.point 明确 x=水平/ y=垂直
        mapInstance.fitBounds(bounds, {
            ...options,
            paddingTopLeft: L.point(halfH + extraLeft, halfV),
            paddingBottomRight: L.point(halfH + extraRight, halfV + extraBottom),
        });
    }

    function setView(center, zoom) {
        if (mapInstance) {
            mapInstance.setView(center, zoom);
        }
    }

    function getZoom() {
        return mapInstance ? mapInstance.getZoom() : 0;
    }

    function getCenter() {
        return mapInstance ? mapInstance.getCenter() : null;
    }

    function destroy() {
        if (mapInstance) {
            mapInstance.remove();
            mapInstance = null;
        }
    }

    // 容器尺寸变化后通知 Leaflet 重新计算（侧边栏折叠/展开改变地图宽度时必须调用，
    // 否则瓦片、缩放控件与鼠标点击→经纬度映射会错位）
    function invalidateSize() {
        if (mapInstance) mapInstance.invalidateSize();
    }

    function getCurrentBaseLayer() {
        return currentBaseLayer;
    }

    // ---------- R95：底图随主题统一变暗（流行做法：栅格瓦片 CSS 滤镜） ----------
    // R91 守卫只在「冷色/暗黑」之间联动切换，用户手动选了 OSM/影像等底图后，
    // 主题切换不再管底图 → 出现「亮色 UI 配暗色地图 / 暗色 UI 配亮色地图」的错配。
    // 流行处理（Google/高德暗色模式、Leaflet 社区通用方案）：暗色主题下对非原生暗色
    // 底图叠加 invert + hue-rotate 滤镜，亮度反转、色相保持，任意底图都呈现暗色；
    // 原生暗色（Esri暗黑地图）与空白底图不处理。
    const TILE_DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.85)';

    function isNativeDarkBasemap(name) {
        return name === 'Esri暗黑地图';
    }

    // 对当前在地图上的所有底图层套用/摘除暗色滤镜（同时最多两层：R94 交叉淡化过渡期）
    function refreshTilesThemeFilter() {
        if (!mapInstance) return;
        let dark = false;
        try { dark = document.documentElement.getAttribute('data-theme') === 'dark'; } catch (e) { return; }
        for (const [name, layer] of Object.entries(baseLayerControls)) {
            if (!mapInstance.hasLayer(layer)) continue;
            const el = typeof layer.getContainer === 'function' ? layer.getContainer() : null;
            if (!el) continue; // 空白底图等无容器
            el.style.filter = (dark && !isNativeDarkBasemap(name)) ? TILE_DARK_FILTER : '';
        }
    }

    // R99：底图切换药丸始终位于「可见地图区域」顶部中心（避开展开的侧边栏）
    function positionBasemapPill() {
        const pill = document.getElementById('basemapPill');
        if (!pill) return;
        const sidebar = document.getElementById('sidebar');
        let visibleLeft = 0;
        if (sidebar && !sidebar.classList.contains('sidebar--collapsed')) {
            visibleLeft = sidebar.getBoundingClientRect().right;
        }
        const visibleWidth = Math.max(0, window.innerWidth - visibleLeft);
        const left = visibleLeft + visibleWidth / 2;
        pill.style.left = `${left}px`;
        pill.style.transform = 'translateX(-50%)';
    }

    return {
        init,
        getMap,
        switchBaseLayer,
        getCurrentBaseLayer,
        refreshTilesThemeFilter,
        fitBounds,
        setView,
        getZoom,
        getCenter,
        invalidateSize,
        repositionBottomHud,
        positionBasemapPill,
        destroy,
    };
})();