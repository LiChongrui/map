/**
 * 地点搜索：本地地名索引
 *
 * 从 uiManager.js 拆出（R163）。遍历全部数据集的 GeoJSON（含未加载的图层）建立地名索引，
 * 不依赖在线地理编码，保证离线 / 国内环境也可用。
 *
 * 依赖：DataScanner（数据集清单）、UIWidgets（提示）、Leaflet L（范围计算）
 */

const PlaceSearch = (function() {

    let searchIndex = null;        // 已建立的地名索引
    let searchIndexPromise = null; // 构建中的 Promise（避免重复拉取）

    // 从要素属性中挑选最适合做名称的字段值（与图层标注挑选逻辑一致：名称类字段优先）
    function pickSearchLabel(props) {
        if (!props) return '';
        const pri = ['name', '名称', '地名', 'label', 'title', '桥', '里坊', '州', '府', '路', '道'];
        for (const k of pri) {
            const v = props[k];
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
        }
        for (const v of Object.values(props)) {
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
        }
        return '';
    }

    // 由要素几何计算其经纬度边界（用于点击结果缩放到该要素，无需先加载数据集）
    function featureBounds(geometry) {
        if (!geometry) return null;
        const bounds = L.latLngBounds();
        const add = ll => { if (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) bounds.extend([ll[1], ll[0]]); };
        const walk = coord => {
            if (coord && typeof coord[0] === 'number') add(coord);
            else if (Array.isArray(coord)) coord.forEach(walk);
        };
        if (geometry.type === 'GeometryCollection') {
            (geometry.geometries || []).forEach(sub => {
                const b = featureBounds(sub);
                if (b) bounds.extend(b);
            });
        } else if (geometry.coordinates) {
            walk(geometry.coordinates);
        }
        return bounds.isValid() ? bounds : null;
    }

    // 构建地名索引：拉取所有数据集的 geojson，提取每个要素的名称与边界并缓存
    let fileProtocolWarned = false;
    async function buildSearchIndex() {
        if (searchIndex) return searchIndex;
        if (searchIndexPromise) return searchIndexPromise;
        searchIndexPromise = (async () => {
            const items = [];
            const datasets = (typeof DataScanner !== 'undefined' && DataScanner.getDatasets) ? DataScanner.getDatasets() : [];
            const sources = [];
            datasets.forEach(ds => (ds.sources || []).forEach(src => sources.push({ src, group: ds.name })));
            // R97：数据集清单尚未就绪（页面刚打开、扫描未完成）时不可缓存空索引——
            // 否则首次搜索若早于扫描完成，空结果会被永久缓存，之后所有搜索都「无结果」
            if (sources.length === 0) {
                searchIndex = null;
                searchIndexPromise = null;
                return [];
            }
            // R97：file:// 打开时 fetch 会被浏览器拦截，索引必然为空——给出明确提示而非静默失败
            if (location.protocol === 'file:' && !fileProtocolWarned) {
                fileProtocolWarned = true;
                UIWidgets.showToast('⚠️ 当前以文件方式打开，搜索功能不可用——请通过本地服务器访问', 'warning');
            }
            await Promise.all(sources.map(async ({ src, group }) => {
                try {
                    // R97：单文件 8s 超时——防止个别请求挂起拖住 Promise.all 导致索引永远建不完
                    const resp = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
                    if (!resp.ok) return;
                    const gj = await resp.json();
                    (gj.features || []).forEach(f => {
                        const props = f.properties || {};
                        const name = pickSearchLabel(props);
                        if (!name) return;
                        const bounds = featureBounds(f.geometry);
                        if (!bounds) return;
                        // R93：hay 纳入图层名与数据集名，支持「城门」「治所」「西苑」等按图层/数据集搜索
                        const hay = [...Object.values(props), src.name || '', group]
                            .map(v => String(v ?? '')).join(' ').toLowerCase();
                        // R106：保留原始要素对象，供点击搜索结果时在地图上高亮其真实几何并弹出属性
                        items.push({ name, group, layerName: src.name, bounds, hay, feature: f });
                    });
                } catch (e) { /* 单个文件失败不影响其它 */ }
            }));
            const seen = new Set();
            const deduped = items.filter(it => {
                const k = it.group + '|' + it.name + '|' + it.layerName;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            // R97：全部文件拉取失败（如以 file:// 打开 / 服务器临时故障）时索引为空——
            // 不缓存空结果，下次搜索自动重试；否则一次网络故障会永久杀死搜索功能
            if (deduped.length === 0) {
                searchIndex = null;
                searchIndexPromise = null;
                return [];
            }
            searchIndex = deduped;
            return searchIndex;
        })();
        return searchIndexPromise;
    }

    // R97：地名匹配分级（供地图搜索与侧边栏双搜共用）——
    // 名称精确 > 名称前缀 > 名称包含 > 全属性（含图层名/数据集名）包含；同级内名称短者优先
    function rankPlaceMatches(index, keyword, limit) {
        const lower = String(keyword || '').trim().toLowerCase();
        if (!lower) return [];
        const rank = it => {
            const n = it.name.toLowerCase();
            if (n === lower) return 0;
            if (n.startsWith(lower)) return 1;
            if (n.includes(lower)) return 2;
            if (it.hay && it.hay.includes(lower)) return 3;
            return 4;
        };
        return index.filter(it => rank(it) < 4)
            .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
            .slice(0, limit);
    }

    // ================================================================
    // updateLayerPanel - 去掉状态文字和删除按钮
    // ================================================================

    // ---------- 公开 API ----------
    return {
        buildSearchIndex,
        rankPlaceMatches,
        featureBounds,
    };

})();
