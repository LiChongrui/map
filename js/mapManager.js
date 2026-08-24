/**
 * 地图核心管理
 */

const MapManager = (function() {
    let mapInstance = null;
    let currentBaseLayer = null;
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
            zoomControl: true,
            fadeAnimation: true,
            attributionControl: true,
        });

        const zoomIn = mapInstance.getContainer().querySelector('.leaflet-control-zoom-in');
        const zoomOut = mapInstance.getContainer().querySelector('.leaflet-control-zoom-out');
        if (zoomIn) {
            zoomIn.removeAttribute('title');
            zoomIn.dataset.tooltip = '放大地图';
        }
        if (zoomOut) {
            zoomOut.removeAttribute('title');
            zoomOut.dataset.tooltip = '缩小地图';
        }

        L.control.scale({
            position: 'bottomright',
            metric: true,
            imperial: false
        }).addTo(mapInstance);

        addBaseLayers();
        mapInstance.getContainer().querySelectorAll('[title]').forEach(element => {
            element.removeAttribute('title');
        });

        window.addEventListener('resize', () => {
            mapInstance.invalidateSize();
        });

        console.log('✅ 地图初始化完成');
        return mapInstance;
    }

    function addBaseLayers() {
        const layers = {};
        for (const [name, layerConfig] of Object.entries(CONFIG.baseLayers)) {
            const tileLayer = L.tileLayer(layerConfig.url, layerConfig.options);
            layers[name] = tileLayer;
            baseLayerControls[name] = tileLayer;

            if (name === CONFIG.defaultBaseLayer) {
                tileLayer.addTo(mapInstance);
                currentBaseLayer = name;
            }
        }

        const BaseLayerControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function() {
                const container = L.DomUtil.create('div', 'leaflet-control base-layer-control');
                container.setAttribute('role', 'group');
                container.setAttribute('aria-label', '底图切换');
                container.innerHTML = '<button type="button" class="base-layer-trigger" aria-label="打开底图选择" aria-expanded="false" data-tooltip="选择底图"><i class="fas fa-map"></i></button><div class="base-layer-menu"><div class="base-layer-options"></div></div>';
                const options = container.querySelector('.base-layer-options');
                const trigger = container.querySelector('.base-layer-trigger');
                trigger.addEventListener('click', () => {
                    const expanded = container.classList.toggle('expanded');
                    trigger.setAttribute('aria-expanded', String(expanded));
                });
                options.addEventListener('click', event => event.stopPropagation());
                Object.keys(layers).forEach(name => {
                    const layerConfig = CONFIG.baseLayers[name];
                    const option = document.createElement('label');
                    option.className = 'base-layer-option';
                    option.dataset.layer = name;
                    option.dataset.tooltip = `切换到${name}`;
                    const icon = layerConfig.icon
                        || ((name.indexOf('卫星') !== -1 || name.indexOf('影像') !== -1) ? 'fa-satellite' : 'fa-road');
                    option.innerHTML = `<input type="radio" name="base-layer" value="${name}"><i class="fas ${icon}" aria-hidden="true"></i><span>${name}</span>`;
                    option.querySelector('input').addEventListener('change', () => {
                        switchBaseLayer(name);
                    });
                    options.appendChild(option);
                });
                document.addEventListener('pointerdown', event => {
                    if (!container.contains(event.target)) {
                        container.classList.remove('expanded');
                        trigger.setAttribute('aria-expanded', 'false');
                    }
                });
                L.DomEvent.disableClickPropagation(container);
                baseLayerControlElement = container;
                updateBaseLayerControl();
                return container;
            }
        });
        new BaseLayerControl().addTo(mapInstance);
    }

    function updateBaseLayerControl() {
        if (!baseLayerControlElement) return;
        baseLayerControlElement.querySelectorAll('.base-layer-option').forEach(option => {
            const active = option.dataset.layer === currentBaseLayer;
            option.classList.toggle('active', active);
            const radio = option.querySelector('input');
            if (radio) radio.checked = active;
        });
    }

    function switchBaseLayer(name) {
        if (!baseLayerControls[name]) return;
        if (currentBaseLayer && baseLayerControls[currentBaseLayer]) {
            mapInstance.removeLayer(baseLayerControls[currentBaseLayer]);
        }
        baseLayerControls[name].addTo(mapInstance);
        currentBaseLayer = name;
        updateBaseLayerControl();
    }

    function getMap() {
        if (!mapInstance) throw new Error('地图未初始化');
        return mapInstance;
    }

    function fitBounds(bounds, options = { padding: [40, 40] }) {
        if (!mapInstance || !bounds || !bounds.isValid()) return;
        // 归一化基础 padding（支持 [v, h] 数组或单一数字）
        const base = Array.isArray(options.padding) ? options.padding
            : (typeof options.padding === 'number' ? [options.padding, options.padding] : [40, 40]);
        const baseV = base[0], baseH = base[1];
        // 图层面板遮挡避让：桌面端面板为右侧竖栏 → 右侧让位；
        // 移动端（≤768px）面板为底部浮层 → 底部让位。
        // 用遮挡区域形状判定主导方向（coverW≈1 且 coverH 较小 → 底部条；反之 → 右侧条）
        let padRight = baseH, padBottom = baseV;
        const panel = document.getElementById('controlPanel');
        if (panel && !panel.classList.contains('collapsed')) {
            const rect = panel.getBoundingClientRect();
            const mapRect = mapInstance.getContainer().getBoundingClientRect();
            const overlapW = Math.min(rect.right, mapRect.right) - Math.max(rect.left, mapRect.left);
            const overlapH = Math.min(rect.bottom, mapRect.bottom) - Math.max(rect.top, mapRect.top);
            if (overlapW > 0 && overlapH > 0) {
                const coverW = overlapW / mapRect.width;
                const coverH = overlapH / mapRect.height;
                if (coverW > 0.5 && coverH < coverW - 0.2) {
                    padBottom = overlapH + 24; // 底部宽条（移动端底部浮层）
                } else if (coverH > 0.5 && coverW < coverH - 0.2) {
                    padRight = overlapW + 24;  // 右侧高条（桌面右栏）
                }
            }
        }
        // 注意：paddingTopLeft/paddingBottomRight 是 Point(x, y)，必须用 L.point 明确 x=水平/ y=垂直，
        // 不能传 [x, y] 数组——Leaflet 对 padding 数组约定为 [垂直, 水平]，方向会错
        mapInstance.fitBounds(bounds, {
            ...options,
            paddingTopLeft: L.point(baseH, baseV),
            paddingBottomRight: L.point(padRight, padBottom),
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

    return {
        init,
        getMap,
        switchBaseLayer,
        fitBounds,
        setView,
        getZoom,
        getCenter,
        destroy,
    };
})();