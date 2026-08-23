/**
 * 图层管理 - 支持多GeoJSON独立控制
 */

const LayerManager = (function() {
    const layers = new Map();
    let totalFeatures = 0;
    let visibleFeatures = 0;
    let activeGroup = '';

    // ---------- 样式生成 ----------
    function createStyleFunction(config) {
        const { color, fillColor } = config;
        return function(feature) {
            let finalColor = color;
            let finalFillColor = fillColor;

            return {
                color: finalColor,
                weight: 1,
                opacity: 0.9,
                fillColor: finalFillColor,
                fillOpacity: 0.5,
                smoothFactor: 1.5,
                interactive: true,
            };
        };
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[character]));
    }

    function getLabelPosition(geometry) {
        if (!geometry) return null;
        const toLatLng = coordinate => L.latLng(coordinate[1], coordinate[0]);
        const coordinates = geometry.coordinates;

        if (geometry.type === 'Point') return toLatLng(coordinates);
        if (geometry.type === 'LineString') {
            const lengths = [];
            let total = 0;
            for (let index = 1; index < coordinates.length; index += 1) {
                const start = toLatLng(coordinates[index - 1]);
                const end = toLatLng(coordinates[index]);
                const length = start.distanceTo(end);
                lengths.push(length);
                total += length;
            }
            let target = total / 2;
            for (let index = 0; index < lengths.length; index += 1) {
                if (target <= lengths[index]) {
                    const ratio = lengths[index] ? target / lengths[index] : 0;
                    return L.latLng(
                        coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * ratio,
                        coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * ratio
                    );
                }
                target -= lengths[index];
            }
        }
        if (geometry.type === 'Polygon') {
            const ring = coordinates[0] || [];
            let area = 0;
            let longitude = 0;
            let latitude = 0;
            for (let index = 0; index < ring.length - 1; index += 1) {
                const current = ring[index];
                const next = ring[index + 1];
                const cross = current[0] * next[1] - next[0] * current[1];
                area += cross;
                longitude += (current[0] + next[0]) * cross;
                latitude += (current[1] + next[1]) * cross;
            }
            if (area) return L.latLng(latitude / (3 * area), longitude / (3 * area));
        }
        const fallback = L.geoJSON({ type: 'Feature', geometry }).getBounds();
        return fallback.isValid() ? fallback.getCenter() : null;
    }

    function createLabelLayer(data) {
        const labelLayer = L.layerGroup();
        let hasName = false;
        data.features.forEach(feature => {
            const name = feature.properties?.name;
            if (name === undefined || name === null || name === '') return;
            hasName = true;
            const geometry = feature.geometry;
            if (!geometry) return;
            const position = getLabelPosition(geometry);
            if (!position) return;
            L.marker(position, {
                icon: L.divIcon({
                    className: `map-feature-label map-feature-label--${geometry.type.toLowerCase()}`,
                    html: escapeHtml(name),
                    iconSize: null,
                    iconAnchor: [0, 0],
                }),
                interactive: false,
            }).addTo(labelLayer);
        });
        return { labelLayer, hasName };
    }

    // ---------- 弹窗绑定 ----------
    function bindPopup(feature, layer, styleConfig) {
        if (!feature.properties) return;

        let popupContent = `<div class="feature-popup-content">`;
        popupContent += `<b class="feature-popup-title">📍 要素详情</b><hr>`;

        const props = feature.properties;
        const displayFields = ['name', 'title', 'type', 'category', 'address', 'description', 'area', 'length'];

        for (const field of displayFields) {
            if (props[field] !== undefined && props[field] !== null && props[field] !== '') {
                popupContent += `<b>${field}</b>: ${props[field]}<br>`;
            }
        }

        for (const [key, value] of Object.entries(props)) {
            if (!displayFields.includes(key) && value !== null && value !== undefined && value !== '') {
                popupContent += `<b>${key}</b>: ${value}<br>`;
            }
        }

        popupContent += `</div>`;
        layer.bindPopup(popupContent, {
            direction: 'top',
            offset: [0, 0],
            autoPan: true,
            autoPanPadding: [24, 24],
            closeButton: true,
        });

        const originalStyle = createStyleFunction(styleConfig)(feature);
        const originalOpacity = layer.options?.opacity ?? 1;
        const restoreOriginalStyle = function() {
            if (typeof this.setStyle === 'function') {
                this.setStyle(originalStyle);
            } else if (typeof this.setOpacity === 'function') {
                this.setOpacity(originalOpacity);
            }
        };
        layer.on('click', function(event) {
            if (typeof this.setStyle === 'function') {
                this.setStyle({ weight: 4, color: '#000', fillOpacity: 0.7 });
            } else if (typeof this.setOpacity === 'function') {
                this.setOpacity(0.7);
            }
            this.bringToFront?.();
            if (event.latlng) this.openPopup(event.latlng);
        });
        layer.on('popupclose', restoreOriginalStyle);
    }

    // ---------- 加载单个图层 ----------
    function loadLayer(sourceConfig) {
        const { id, name, url, color, fillColor, visible } = sourceConfig;

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
                const styleFn = createStyleFunction({ color, fillColor });

                const geoLayer = L.geoJSON(data, {
                    style: styleFn,
                    pointToLayer: (feature, latlng) => L.marker(latlng, {
                        icon: L.divIcon({
                            className: 'map-feature-point-icon',
                                    html: `<span class="point-ring" style="--point-color:${color};"><span class="point-core"></span></span>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 22],
                        }),
                    }),
                    onEachFeature: (feature, layer) => bindPopup(feature, layer, { color, fillColor }),
                });
                const { labelLayer, hasName } = createLabelLayer(data);

                const layerInfo = {
                    layer: geoLayer,
                    data: data,
                    visible: visible,
                    config: { ...sourceConfig, color, fillColor },
                    featureCount: data.features.length,
                    labelLayer,
                    hasName,
                    labelsVisible: false,
                    _id: id,
                };

                layers.set(id, layerInfo);

                if (visible && (!activeGroup || activeGroup === sourceConfig.group)) {
                    geoLayer.addTo(map);
                    visibleFeatures += data.features.length;
                }
                if (!activeGroup || activeGroup === sourceConfig.group) {
                    totalFeatures += data.features.length;
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

    // ---------- 加载所有 ----------
    function loadAllLayers() {
        for (const info of layers.values()) {
            if (info.visible) MapManager.getMap().removeLayer(info.layer);
        }
        totalFeatures = 0;
        visibleFeatures = 0;
        layers.clear();

        if (!CONFIG.dataSources || CONFIG.dataSources.length === 0) {
            console.warn('⚠️ 数据源为空，请检查 data/manifest.json');
            UIManager.updateLayerPanel();
            UIManager.updateStats(0, 0, 0);
            UIManager.updateButtonsState(false);
            return Promise.resolve();
        }

        const sorted = [...CONFIG.dataSources].sort((a, b) => (a.order || 0) - (b.order || 0));
        const promises = sorted.map(src => loadLayer(src));
        
        return Promise.all(promises).then(results => {
            const loadedLayers = new Map(layers);
            layers.clear();
            sorted.forEach(source => {
                const info = loadedLayers.get(source.id);
                if (info) layers.set(source.id, info);
            });
            UIManager.updateLayerPanel();
            UIManager.updateLegend();
            updateStats();
            const hasData = layers.size > 0;
            UIManager.updateButtonsState(hasData);
            return {
                loaded: results.filter(result => result?.success !== false).length,
                failed: results.filter(result => result?.success === false).length,
                layers,
            };
        });
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

        const map = MapManager.getMap();
        layers.forEach(info => {
            if (info.visible) map.removeLayer(info.layer);
        });
        layers.forEach(info => {
            if (info.visible) map.addLayer(info.layer);
        });
        CONFIG.dataSources.forEach(source => {
            const index = orderedIds.indexOf(source.id);
            if (index >= 0) source.order = index;
        });
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
                    visibleFeatures += info.featureCount;
                } else {
                    map.removeLayer(info.layer);
                    if (info.labelsVisible) map.removeLayer(info.labelLayer);
                    visibleFeatures -= info.featureCount;
                }
            }
        });
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
    }

    // ---------- 切换显隐 ----------
    function toggleLayer(id) {
        console.log('🔄 toggleLayer 被调用, id:', id);
        
        const info = layers.get(id);
        if (!info) {
            console.warn('⚠️ 图层不存在:', id);
            return;
        }

        const map = MapManager.getMap();
        
        if (info.visible) {
            map.removeLayer(info.layer);
            if (info.labelsVisible) map.removeLayer(info.labelLayer);
            info.visible = false;
            visibleFeatures -= info.featureCount;
            console.log('👁️ 隐藏:', info.config.name);
        } else {
            map.addLayer(info.layer);
            if (info.labelsVisible) info.labelLayer.addTo(map);
            info.visible = true;
            visibleFeatures += info.featureCount;
            console.log('👁️ 显示:', info.config.name);
        }

        // 🔥 关键：更新 UI
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
    }

    // ---------- 移除图层 ----------
    function removeLayer(id) {
        const info = layers.get(id);
        if (!info) return;

        if (info.visible) {
            MapManager.getMap().removeLayer(info.layer);
            visibleFeatures -= info.featureCount;
        }
        totalFeatures -= info.featureCount;
        layers.delete(id);

        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
        return true;
    }

    // ---------- 清除所有 ----------
    function clearAll() {
        for (const [id] of layers) {
            removeLayer(id);
        }
        layers.clear();
        totalFeatures = 0;
        visibleFeatures = 0;
        UIManager.updateLayerPanel();
        UIManager.updateLegend();
        updateStats();
        UIManager.updateButtonsState(false);
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
        if (!info || !info.hasName) return false;
        const map = MapManager.getMap();
        info.labelsVisible = !info.labelsVisible;
        if (info.labelsVisible && info.visible) info.labelLayer.addTo(map);
        else map.removeLayer(info.labelLayer);
        UIManager.updateLayerPanel();
        return info.labelsVisible;
    }

    // ---------- 导出全部 ----------
    function getAllData() {
        const allFeatures = [];
        for (const [, info] of layers) {
            if (info.data && info.data.features) {
                allFeatures.push(...info.data.features);
            }
        }
        return {
            type: 'FeatureCollection',
            features: allFeatures,
            metadata: {
                totalFeatures: allFeatures.length,
                layers: Array.from(layers.keys()),
                exportedAt: new Date().toISOString(),
            }
        };
    }

    // ---------- 统计更新 ----------
    function updateStats() {
        const total = totalFeatures;
        const visible = visibleFeatures;
        const count = layers.size;
        
        document.getElementById('statsTotal').textContent = total;
        document.getElementById('statsVisible').textContent = visible;
        document.getElementById('statsLayers').textContent = count;
        document.getElementById('footerTotal').textContent = total;
        document.getElementById('footerVisible').textContent = visible;
        const layerCount = document.getElementById('datasetLayerCount');
        if (layerCount) layerCount.textContent = count;
        
        // 更新徽标
        
        // 调用 UIManager 更新
        if (typeof UIManager !== 'undefined' && UIManager.updateStats) {
            UIManager.updateStats(total, visible, count);
        }
    }

    // ---------- 搜索过滤 ----------
    function filterLayers(keyword) {
        const items = document.querySelectorAll('.layer-item');
        const lower = keyword.toLowerCase();
        items.forEach(item => {
            const name = item.dataset.name?.toLowerCase() || '';
            item.style.display = name.includes(lower) ? 'flex' : 'none';
        });
    }

    // ---------- 获取信息 ----------
    function getLayerInfo(id) { return layers.get(id) || null; }
    function getAllLayers() { return layers; }
    function getLayersByGroup(group) {
        return new Map([...layers].filter(([, info]) => (info.config.group || '古代洛阳城') === group));
    }

    function activateGroup(group) {
        const map = MapManager.getMap();
        activeGroup = group;
        layers.forEach(info => {
            const inGroup = (info.config.group || '未分组') === group;
            if (!inGroup) {
                map.removeLayer(info.layer);
                map.removeLayer(info.labelLayer);
            } else if (info.visible) {
                info.layer.addTo(map);
                if (info.labelsVisible) info.labelLayer.addTo(map);
            }
        });
        totalFeatures = 0;
        visibleFeatures = 0;
        getLayersByGroup(group).forEach(info => {
            totalFeatures += info.featureCount;
            if (info.visible) visibleFeatures += info.featureCount;
        });
        updateStats();
        UIManager.updateLegend();
    }
    function getTotalFeatures() { return totalFeatures; }
    function getVisibleFeatures() { return visibleFeatures; }

    return {
        loadLayer,
        loadAllLayers,
        setLayerOrder,
        setAllVisibility,
        activateGroup,
        toggleLayer,
        removeLayer,
        clearAll,
        zoomToLayer,
        toggleLabels,
        getAllData,
        getLayerInfo,
        getAllLayers,
        getLayersByGroup,
        getTotalFeatures,
        getVisibleFeatures,
        filterLayers,
        updateStats,
    };
})();