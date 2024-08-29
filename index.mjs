#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import util from './util.mjs';
import poolManager from './pool-manager.mjs';
import path from 'path';
import fs from 'fs/promises';


const argv = yargs(hideBin(process.argv)).argv

argv.batchSize = Number(argv.batchSize || 10000);

const config = await util.loadConfig(['./.config.json', './.config.local.json']);

const src = splitConnectionTable(argv.src), dest = splitConnectionTable(argv.dest);

dest.table = dest.table || src.table;

if (!src.connection || !src.table || !dest.connection || !dest.table) {
    help();
}

if (src.connection === dest.connection && src.table === dest.table) {
    console.error('Source and destination tables are the same');
    process.exit(1);
}

if (src.connection === "file") {
    src.isFile = true;
}

if (dest.connection === "file") {
    dest.isFile = true;
}

if (src.connection === "file" && dest.connection === "file") {
    console.error('Source and destination connections cannot be both file');
    process.exit(1);
}

if (src.isFile) {
    if (!(await util.fileExists(src.table))) {
        console.error(`Source file ${src.table} not found`);
        process.exit(1);
    }
} else {
    await initConnection(src);
    if (!src.columns || !src.columns.length) {
        console.error(`Table ${src.table} not found in source connection ${src.connection}.`);
        process.exit(1);
    }
}

if (dest.isFile) {
    if (await util.fileExists(dest.table)) {
        console.error(`Destination file ${dest.table} already exists`);
        process.exit(1);
    }
} else {
    await initConnection(dest);
}

const errors = [];
if (!src.isFile) {
    const tableCreateStatement = await generateCreateTableQuery({ columns: src.columns, table: dest.table });
    if (dest.isFile) {
        const sqlFile = path.basename(dest.table) + '-create.sql';
        console.log(`Writing create table SQL to ${sqlFile}`);
        await fs.writeFile(sqlFile, tableCreateStatement);
    } else {
        if (!dest.columns || !dest.columns.length) {
            console.log(`Table ${dest.table} not found in destination connection ${dest.connection}.`);
            console.log('Creating target table...');
            console.log('Utility has limitations on creating tables. Please make sure the table is created with the correct schema.');
            dest.pool.request().query(tableCreateStatement);
        } else {
            src.columns.forEach((column, index) => {
                const destColumn = dest.columns.find((destColumn) => destColumn.COLUMN_NAME === column.COLUMN_NAME);
                let error;
                if (!destColumn) {
                    error = 'Column not found in destination database';
                } else if (destColumn.DATA_TYPE !== column.DATA_TYPE || destColumn.CHARACTER_MAXIMUM_LENGTH !== column.CHARACTER_MAXIMUM_LENGTH) {
                    error = `Data type mismatch ${destColumn.DATA_TYPE} ${destColumn.CHARACTER_MAXIMUM_LENGTH} != ${column.DATA_TYPE} ${column.CHARACTER_MAXIMUM_LENGTH}`;
                }
                if (error) {
                    errors.push(`${column.COLUMN_NAME}: ${error}`);
                    return true;
                }
            });
            dest.columns.forEach((column, index) => {
                const srcColumn = src.columns.find((srcColumn) => srcColumn.COLUMN_NAME === column.COLUMN_NAME);
                if (!srcColumn) {
                    errors.push(`Extra column found in destination database: ${column.COLUMN_NAME}`);
                }
            });
        }
    }
}

if (errors.length) {
    for (const error of errors) {
        console.log(error);
    }
    process.exit(2);
}
if (!dest.isFile) {
    const existingRows = await dest.pool.request().query(`SELECT COUNT(*) AS count FROM ${dest.table}`);
    const existingRowsCount = existingRows.recordset[0].count;
    if (existingRowsCount) {
        console.error(`Table ${dest.table} already has ${existingRowsCount} rows. Aborting...`);
        process.exit(3);
    }
}

let cmd;
if (!src.isFile) {
    console.log(`Fetching data from ${src.connection} ${src.pool.config.database} > ${src.table}...`);
    cmd = util.replaceTags(config.commands.download, { sourceTable: src.table, tempFileName: dest.isFile ? dest.table : 'tmp.bcp', ...src.pool.config, batchSize: argv.batchSize });
    console.log(cmd);
    await util.execCommand(cmd);
}
if (!dest.isFile) {
    console.log(`Pushing data to ${dest.connection} ${dest.pool.config.database} > ${dest.table}...`);
    cmd = util.replaceTags(config.commands.upload, { targetTable: dest.table, tempFileName: src.isFile ? src.table : 'tmp.bcp', ...dest.pool.config, batchSize: argv.batchSize });
    console.log(cmd);
    await util.execCommand(cmd);
}

async function generateCreateTableQuery({ columns, table }) {
    const columnInfo = [];
    for (const column of columns) {
        let columnStatemet = `    [${column.COLUMN_NAME}] ${column.DATA_TYPE}`;
        if (!column.DATA_TYPE) {
            throw new Error(`Data type not found for column ${column.COLUMN_NAME}`);
        }
        const isChar = /CHAR$/i.test(column.DATA_TYPE);
        if (column.CHARACTER_MAXIMUM_LENGTH) {
            if (column.CHARACTER_MAXIMUM_LENGTH === -1) {
                columnStatemet += '(MAX)';
            } else if (isChar) {
                columnStatemet += `(${column.CHARACTER_MAXIMUM_LENGTH})`;
            } else if (column.NUMERIC_PRECISION) {
                columnStatemet += `(${column.NUMERIC_PRECISION},${column.NUMERIC_SCALE})`;
            }
        }
        columnStatemet += column.IS_NULLABLE === 'NO' ? ' NOT NULL' : '';
        if (column.COLUMN_DEFAULT) {
            columnStatemet += isChar ? ` DEFAULT '${column.COLUMN_DEFAULT}'` : ` DEFAULT ${column.COLUMN_DEFAULT}`;
        }
        columnInfo.push(columnStatemet);
    }
    return `CREATE TABLE ${table} (\n${columnInfo.join(',\n')}\n);`;
}

async function initConnection(conn) {
    const { pool, table, connection } = conn;
    const connectionConfig = config.connections[connection];

    console.log(`Connecting to ${connection}...`);
    conn.pool = await poolManager.get(connection, connectionConfig);

    console.log(`Fetching table information for ${connectionConfig.database} > ${table}...`);
    let query = `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @TableName ORDER BY ORDINAL_POSITION; `
    const result = await conn.pool.request()
        .input('TableName', table)
        .query(query);

    conn.columns = result.recordset;
    return conn.columns;
}

function help() {
    console.log('src: source connection and table separated by ":". Example: "connection:table"');
    console.log('dest: destination connection and table separated by ":". Example: "connection:table"');
    //console.log('force: drop destination table if exists');
    console.log('batchSize: transaction batch size. Default 10000');
    process.exit(1);
}

function splitConnectionTable(connectionTable = '') {
    const [connection, table] = connectionTable.split(':');
    return { connection, table };
}