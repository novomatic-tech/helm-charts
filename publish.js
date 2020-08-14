const { join, basename } = require('path');
const axios = require('axios');
const fs = require('fs');
const yaml = require('js-yaml');

class HelmRepoIndex {

    static empty() {
        return new HelmRepoIndex({
            apiVersion: 'v1',
            entries: {}
        });
    }

    static fromYaml(yamlContent) {
        return new HelmRepoIndex(yaml.safeLoad(yamlContent));
    }

    constructor(representation) {
        this.representation = representation;
        if (!this.representation || !this.representation.entries) {
            throw new Error('Representation must contain a collection of entries');
        }
    }

    findChart(chartName, version) {
        const charts = this.representation.entries[chartName] || [];
        const foundCharts = charts.filter(
            c => c.version === version);
        return foundCharts.length > 0 ? foundCharts[0] : null;
    }

    forEachChart(action) {
        Object.keys(this.representation.entries)
            .forEach(chartName => {
                const charts = this.representation.entries[chartName];
                charts.forEach(chart => action(chart));
            });
    }

    addChart(chart) {
        const existingChart = this.findChart(chart.name, chart.version);
        if (existingChart) {
            if (existingChart.digest === chart.digest) {
                console.log(`The ${chart.name}-${chart.version} chart already exists in the upstream repo ` +
                    'and it has the same content as the chart that\'s about to be added. Skipping...');
                return false;
            } else {
                throw new Error(`The ${chart.name}-${chart.version} chart already exists in the upstream repo ` +
                    'but its content is different from the chart that\'s about to be added. ' +
                    'Did you forget to bump the chart version when applying changes?');
            }
        } else {
            if (!this.representation.entries[chart.name]) {
                this.representation.entries[chart.name] = []
            }
            this.representation.entries[chart.name].unshift(chart);
            return true;
        }
    }

    merge(newChartsIndex) {
        const mergedIndex = this.clone();
        const addedCharts = [];
        newChartsIndex.forEachChart((chart) => {
            const chartAdded = mergedIndex.addChart(chart);
            if (chartAdded) {
                addedCharts.push(chart);
            }
        });
        return { mergedIndex, addedCharts };
    }

    clone() {
        return new HelmRepoIndex(JSON.parse(JSON.stringify(this.representation)));
    }

    toYaml() {
        return yaml.safeDump(this.representation);
    }
}

class RemoteHelmRepo {

    constructor(repoConfig) {
        this.repoConfig = repoConfig;
        if (!this.repoConfig.repository) {
            throw new Error('Missing --repository parameter.')
        }
    }

    async getIndex() {
        const url = `${this.repoConfig.repository}/index.yaml`;
        try {
            const indexResponse = await axios.get(url, { headers: this._authHeaders() });
            return HelmRepoIndex.fromYaml(indexResponse.data);
        } catch(e) {
            const message = `Unable to get repository index ${url}`;
            if (e.response.status === 404) {
                console.warn(`${message}. The index file is missing. Assuming this is the first deployment.`);
                return HelmRepoIndex.empty();
            } else {
                throw new Error(`${message}. ${e.message}`);
            }
        }
    }

    async publishChart(chartArchivePath) {
        console.log(`Publishing ${chartArchivePath}`);
        const filename = basename(chartArchivePath);
        const data = fs.readFileSync(chartArchivePath);
        await this._uploadFile(filename, data, { 'content-type': 'application/x-tgz' });
    }

    async updateIndex(index) {
        console.log(`Updating remote repo index`);
        await this._uploadFile('index.yaml', index.toYaml(), { 'content-type': 'text/x-yaml' });
    }

    async _uploadFile(filename, data, headers = {}) {
        try {
            await axios.put(`${this.repoConfig.repository}/${filename}`, data, {
                headers: Object.assign({}, this._authHeaders(), headers),
                'maxContentLength': Infinity,
                'maxBodyLength': Infinity
            });
        } catch(e) {
            throw new Error(`Unable to upload ${filename}. ${e.message}: ${e.response.statusText}`);
        }
    }

    _authHeaders() {
        if (!this.repoConfig.username || !this.repoConfig.password) {
            return {};
        }
        const base64Credentials = Buffer.from(`${this.repoConfig.username}:${this.repoConfig.password}`).toString('base64');
        return {
            'authorization': `Basic ${base64Credentials}`
        };
    };
}

class LocalHelmRepo {
    constructor(dirPath) {
        this.dirPath = dirPath;
    }
    async getIndex() {
        try {
            const yamlContent = fs.readFileSync(join(this.dirPath, 'index.yaml'), 'utf8');
            return HelmRepoIndex.fromYaml(yamlContent);
        } catch(e) {
            throw new Error(`Unable to load local repo index: ${this.dirPath}. ${e.message}`);
        }
    }
}

const publish = async (args) => {
    const {chartsDir} = args;
    if (!chartsDir) {
        throw new Error('Missing --chartsDir parameter.')
    }
    const localRepo = new LocalHelmRepo(chartsDir);
    const remoteRepo = new RemoteHelmRepo(args);

    const localIndex = await localRepo.getIndex();
    const remoteIndex = await remoteRepo.getIndex();

    const result = remoteIndex.merge(localIndex);
    if (result.addedCharts.length > 0) {
        console.log(`There are ${result.addedCharts.length} new chart(s) to publish`);
        for (let chart of result.addedCharts) {
            await remoteRepo.publishChart(join(chartsDir, `${chart.name}-${chart.version}.tgz`));
        }
        await remoteRepo.updateIndex(result.mergedIndex);
        console.log('Charts deployed successfully.');
    } else {
        console.log('No changes in remote repo index.');
    }
};

module.exports = {
    publish,
    setup: (parser) => {
        parser.addCommand('publish', 'Publishes all charts from the <chartsDir> directory to the <repository>')
            .addArgument(['-c', '--chartsDir'], { help: 'A directory containing built charts packages', defaultValue: 'charts-output' })
            .addArgument(['-r', '--repository'], { help: 'Helm charts repository URL' })
            .addArgument(['-u', '--username'], { help: 'The username for the Helm charts repository' })
            .addArgument(['-p', '--password'], { help: 'The password for the Helm charts repository' })
            .setHandler(publish);
    }
};
