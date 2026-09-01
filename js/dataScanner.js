/**
 * 数据加载器 - 从 manifest.json 读取数据集配置
 *
 * manifest 支持以下格式（均可混用字符串或 { file, name, color } 对象）：
 *   1. 推荐：{ "datasets": [{ "name": "数据集名", "files": [...] }, ...] }
 *   2. 旧版：{ "dataset": { "分组名": [files...] } }
 *   3. 旧版：{ "dataset": [{ "name": ..., "files": [...] }] }
 *   4. 旧版：{ "files": [...] }（全部归入“未分组”）
 *
 * 解析结果为数据集列表：[{ name, sources: [layerSourceConfig...] }]
 * 图层是否加载由用户在界面上“添加数据集”决定，此处只负责解析。
 */

const DataScanner = (function() {

    let datasets = [];

    // ---------- manifest → 数据集原始结构 ----------
    function parseManifest(manifest) {
        const list = [];
        if (Array.isArray(manifest.datasets)) {
            manifest.datasets.forEach(dataset => {
                if (!dataset || typeof dataset !== 'object') return;
                const name = String(dataset.name || '').trim() || '未命名数据集';
                // 数据集分组：manifest 显式 category 优先，缺省由名称规则推断（见 inferCategory）
                list.push({ name, files: Array.isArray(dataset.files) ? dataset.files : [], info: dataset.info || '', category: dataset.category || '' });
            });
        } else if (manifest.dataset && typeof manifest.dataset === 'object' && !Array.isArray(manifest.dataset)) {
            Object.entries(manifest.dataset).forEach(([name, files]) => {
                list.push({ name, files: Array.isArray(files) ? files : [], category: '' });
            });
        } else if (Array.isArray(manifest.dataset)) {
            manifest.dataset.forEach(dataset => {
                if (!dataset || typeof dataset !== 'object') return;
                list.push({ name: String(dataset.name || '未分组'), files: Array.isArray(dataset.files) ? dataset.files : [], category: dataset.category || '' });
            });
        } else if (Array.isArray(manifest.files)) {
            list.push({ name: '未分组', files: manifest.files, category: '' });
        }
        return list;
    }

    // ---------- 数据集分组（分类） ----------
    // 分组展示顺序：列出的优先按此顺序，未列出的按出现顺序排在后面
    const CATEGORY_ORDER = ['古代洛阳', '古代北京', '历代行政区划'];
    // 无显式 category 时的兜底推断（保证新增数据集也有合理归属）
    function inferCategory(name) {
        if (/洛阳/.test(name)) return '古代洛阳';
        if (/北京/.test(name)) return '古代北京';
        if (/行政区划/.test(name)) return '历代行政区划';
        return '其他';
    }
    // 当前全部数据集的分类名（有序）
    function getCategories() {
        const set = new Set();
        datasets.forEach(d => set.add(d.category || '其他'));
        const list = [...set];
        return list.sort((a, b) => {
            const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
            return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
        });
    }
    // 按分类取数据集（保持清单内相对顺序）
    function getDatasetsByCategory(category) {
        return datasets.filter(d => (d.category || '其他') === category);
    }

    // ---------- 从 manifest.json 加载数据集 ----------
    async function scanAndLoad() {
        try {
            const response = await fetch('data/manifest.json');

            if (!response.ok) {
                console.error('❌ manifest.json 加载失败! 状态码:', response.status);
                console.warn('💡 请确保 data/manifest.json 文件存在');
                datasets = [];
                CONFIG.datasets = datasets;
                CONFIG.dataSources = [];
                return datasets;
            }

            const manifest = await response.json();
            const raw = parseManifest(manifest);

            if (raw.length === 0) {
                console.warn('⚠️ manifest.json 中无有效数据集');
                datasets = [];
                CONFIG.datasets = datasets;
                CONFIG.dataSources = [];
                return datasets;
            }

            const colorPalette = CONFIG.colorPalette || [];
            let colorIndex = 0;

            datasets = raw.map((dataset, datasetIndex) => {
                const sources = dataset.files
                    .map(entry => {
                        const isObject = entry && typeof entry === 'object';
                        const file = isObject ? (entry.file || entry.path || '') : String(entry || '');
                        if (!file) return null;
                        const name = (isObject && entry.name) || getDisplayName(file);
                        const color = (isObject && entry.color) || colorPalette[colorIndex++ % colorPalette.length];
                        // 可选默认样式（style 对象，键与图层样式一致；缺省键回退 color → 代码默认）
                        const style = (isObject && entry.style && typeof entry.style === 'object') ? entry.style : null;
                        return {
                            // id 含数据集名前缀，跨数据集同名文件不会冲突；保持旧规则以兼容已保存的样式
                            id: generateId(`${dataset.name}_${file}`),
                            name: name || file,
                            url: 'data/' + file,
                            color: color,
                            style: style,
                            fillColor: color + '33',
                            group: dataset.name,
                            visible: true,
                            order: colorIndex,
                            filename: file,
                        };
                    })
                    .filter(Boolean);
                return {
                    name: dataset.name,
                    order: datasetIndex,
                    sources,
                    info: dataset.info || '',
                    // 分组：显式 category → 规则推断 → 其他
                    category: dataset.category || inferCategory(dataset.name),
                };
            }).filter(dataset => dataset.sources.length > 0);

            CONFIG.datasets = datasets;
            // 兼容旧引用：全部数据源平铺列表
            CONFIG.dataSources = datasets.reduce((all, dataset) => all.concat(dataset.sources), []);

            return datasets;

        } catch (error) {
            console.error('❌ 读取 manifest.json 失败:', error.message);
            datasets = [];
            CONFIG.datasets = datasets;
            CONFIG.dataSources = [];
            return datasets;
        }
    }

    // ---------- 生成显示名称 ----------
    function getDisplayName(filename) {
        let name = filename.replace(/\.(geojson|json)$/i, '');
        name = name.replace(/[_-]/g, ' ');
        name = name.replace(/\b\w/g, l => l.toUpperCase());
        if (name.length > 25) {
            name = name.substring(0, 23) + '…';
        }
        return name || filename;
    }

    // ---------- 生成唯一ID ----------
    function generateId(filename) {
        return filename
            .replace(/\.(geojson|json)$/i, '')
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')
            .toLowerCase();
    }

    // ---------- 获取数据集 ----------
    function getDatasets() {
        return datasets;
    }

    function getDataset(name) {
        return datasets.find(dataset => dataset.name === name) || null;
    }

    // ---------- 公开 API ----------
    return {
        scanAndLoad,
        getDatasets,
        getDataset,
        generateId,
        getDisplayName,
        getCategories,
        getDatasetsByCategory,
        inferCategory,
    };

})();
