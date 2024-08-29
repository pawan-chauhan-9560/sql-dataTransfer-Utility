import fs from 'fs/promises';
import { spawn } from 'node:child_process';

const defaultTemplate = /\${((\w+)\.)?(\w+)}/gm;

const util = {

    fileExists: async (file) => {
        try {
            await fs.stat(file);
            return true;
        } catch (error) {
            return false;
        }
    },

    loadConfig: async ([...paths]) => {
        const config = {};
        for (const file of paths) {
            if (await fs.stat(file)) {
                const data = JSON.parse(await fs.readFile(file, 'utf8'));
                Object.assign(config, data);
            }
        }
        return config;
    },

    loadFileContent: async (file, encoding = 'utf8') => {
        return await fs.readFile(file, encoding);
    },

    /**
     * @description Replaces the given tags in the given source with the given values.
     * @param {string} source The source to replace the tags in.
     * @param {object} values The values to replace the tags with.
     * @param {object} options template - Regex to use for matching tags, keepMissingTags - Whether to keep tags that are not replaced.
     * @returns {string} The source with the tags replaced.
     * @example
     * // Replaces all tags in the given source with the given values.
     * console.log(template("${firstName} ${lastName}", { firstName: "John", lastName: "Doe" }));
     * // -> "John Doe"
     * // Two level tags are supported.
     * console.log(template("${user.firstName} ${user.lastName}", { user: { firstName: "John", lastName: "Doe" } }));
     * // -> "John Doe"
     **/
    replaceTags: function (source, tags, { template = defaultTemplate, keepMissingTags = false } = {}) {
        if (!source || !tags) {
            return source;
        }

        return source.replace(template, function (match, g1, g2, g3) {
            const container = g2 ? tags[g2] || {} : tags;
            if (container[g3] === undefined) {
                return keepMissingTags ? match : "";
            }
            return container[g3];
        });
    },

    execCommand: async (command) => {
        return new Promise((resolve, reject) => {
            const childProcess = spawn(command, {
                stdio: 'inherit',
                shell: true
            });
            childProcess.on('error', (error) => {
                reject(error);
            });
            childProcess.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Command exited with code ${code}.`));
                }
            });
        });
    }
};

export default util;