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
        addBaseLayerLabel();
        mapInstance.getContainer().querySelectorAll('[title]').forEach(element => {
            element.removeAttribute('title');
        });

        window.addEventListener('resize', () => {
            mapInstance.invalidateSize();
        });

        console.log('✅ 地图初始化完成');
        return mapInstance;
    }

    // 空白底图：无瓦片的空图层（显示地图容器背景色）
    const BlankLayer = L.Layer.extend({
        onAdd: function() {},
        onRemove: function() {},
    });

    function addBaseLayers() {
        const layers = {};
        for (const [name, layerConfig] of Object.entries(CONFIG.baseLayers)) {
            const layer = layerConfig.url
                ? L.tileLayer(layerConfig.url, layerConfig.options)
                : new BlankLayer();
            layers[name] = layer;
            baseLayerControls[name] = layer;

            if (name === CONFIG.defaultBaseLayer) {
                layer.addTo(mapInstance);
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
        updateBaseLayerLabel();
    }

    // 地图左下角当前底图名称徽章
    function addBaseLayerLabel() {
        const labelControl = L.control({ position: 'bottomleft' });
        labelControl.onAdd = function() {
            const el = L.DomUtil.create('div', 'leaflet-control current-base-layer');
            el.setAttribute('aria-label', '当前底图');
            baseLayerLabelEl = el;
            updateBaseLayerLabel();
            return el;
        };
        labelControl.addTo(mapInstance);
    }

    function updateBaseLayerLabel() {
        if (!baseLayerLabelEl) return;
        baseLayerLabelEl.innerHTML = '';
        const icon = document.createElement('i');
        icon.className = 'fas fa-map';
        const span = document.createElement('span');
        span.textContent = currentBaseLayer || '';
        baseLayerLabelEl.appendChild(icon);
        baseLayerLabelEl.appendChild(span);
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

    function fitBounds(bounds, options = { padding: [32, 32] }) {
        if (!mapInstance || !bounds || !bounds.isValid()) return;
        // 归一化基础 padding（支持 [v, h] 数组或单一数字）
        const base = Array.isArray(options.padding) ? options.padding
            : (typeof options.padding === 'number' ? [options.padding, options.padding] : [32, 32]);
        const baseV = base[0], baseH = base[1];
        // 图层面板遮挡避让：桌面端面板为右侧竖栏 → 右侧让位；
        // 移动端（≤768px）面板为底部浮层 → 底部让位。
        // 用遮挡区域形状判定主导方向（coverW≈1 且 coverH 较小 → 底部条；反之 → 右侧条）
        // 关键：paddingBottomRight 只放「额外避让量」（无避让时为 0）——
        // Leaflet 的 zoom 计算用「地图尺寸 - (paddingTopLeft + paddingBottomRight)」，
        // 若把基础 padding 也放进 BR 会导致四周 padding 翻倍、内容被过度压缩
        let extraRight = 0, extraBottom = 0;
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
                    extraBottom = overlapH + 16; // 底部宽条（移动端底部浮层）
                } else if (coverH > 0.5 && coverW < coverH - 0.2) {
                    extraRight = overlapW + 16;  // 右侧高条（桌面右栏）
                }
            }
        }
        // 注意：paddingTopLeft/paddingBottomRight 是 Point(x, y)，必须用 L.point 明确 x=水平/ y=垂直
        mapInstance.fitBounds(bounds, {
            ...options,
            paddingTopLeft: L.point(baseH, baseV),
            paddingBottomRight: L.point(extraRight, extraBottom),
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