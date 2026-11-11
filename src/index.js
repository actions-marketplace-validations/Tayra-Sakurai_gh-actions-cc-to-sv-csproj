import * as core from "@actions/core";
import * as github from "@actions/github";
import { Bumper } from "conventional-recommended-bump";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import preset from "conventional-changelog-conventionalcommits";
import { XMLParser } from "fast-xml-parser";
import XMLBuilder from "fast-xml-builder";

function findTag(nodes, tagName) {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (node[tagName]) return node[tagName];
    for (const key of Object.keys(node)) {
      if (key !== ":@" && Array.isArray(node[key])) {
        const found = findTag(node[key], tagName);
        if (found) return found;
      }
    }
  }
  return null;
}

function getTagValue(nodes, tagName) {
  const node = findTag(nodes, tagName);
  if (!node || !Array.isArray(node)) return null;
  const textObj = node.find((child) => "#text" in child);
  return textObj ? String(textObj["#text"]) : "";
}

function setTagValue(nodes, tagName, value) {
  const node = findTag(nodes, tagName);
  if (!node || !Array.isArray(node)) return false;
  const textObj = node.find((child) => "#text" in child);
  if (textObj) {
    textObj["#text"] = value;
  } else {
    node.push({ "#text": value });
  }
  return true;
}

function setOrAddTagValue(nodes, tagName, value, nearTagName = null) {
  if (setTagValue(nodes, tagName, value)) return;
  if (nearTagName) {
    function addToParent(list) {
      if (!Array.isArray(list)) return false;
      for (let i = 0; i < list.length; i++) {
        if (list[i][nearTagName]) {
          list.splice(i + 1, 0, { [tagName]: [{ "#text": value }] });
          return true;
        }
        for (const key of Object.keys(list[i])) {
          if (key !== ":@" && Array.isArray(list[i][key])) {
            if (addToParent(list[i][key])) return true;
          }
        }
      }
      return false;
    }
    addToParent(nodes);
  }
}

async function run() {
  try {
    const bumper = new Bumper();
    bumper.loadPreset('conventionalcommits', () => preset);
    const tag = core.getInput('tag');
    if (tag)
      bumper.tag(tag);
    const paths = core.getMultilineInput('path');
    const { level, releaseType } = await bumper.bump();
    for (const path of paths) {
      const content = readFileSync(path, 'utf-8');
      core.info(content);
      const rawxml = content.replace(/^\ufeff/, '');
      core.info(rawxml);
      const parser = new XMLParser({
        preserveOrder: true,
        commentPropName: "#comment",
        ignoreAttributes: false,
        parseTagValue: false,
      });
      const xml = parser.parse(rawxml);
      const versionTagP = getTagValue(xml, 'Version');
      const versionTagA = getTagValue(xml, 'AssemblyVersion');
      if (!versionTagP || !versionTagA) {
        throw new Error(`Version or AssemblyVersion not found in ${path}`);
      }
      let [ major, minor, patch, ...suffix ] = versionTagP.split(/\.|-/);
      let build = Number.parseInt(versionTagA.split(/\D/)[3]);
      switch (level) {
        case 0:
          if (suffix.length > 0) {
            suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1]) + 1) : '1';
            build++;
            break;
          }
          build = 0;
          minor = '0';
          patch = '0';
          major = String(Number.parseInt(major) + 1)
          break;
        case 1:
          if (suffix.length > 0) {
            suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1]) + 1) : '1';
            build++;
            break;
          }
          build = 0;
          patch = '0';
          minor = String(Number.parseInt(minor) + 1);
          break;
        case 2:
          if (suffix.length > 0) {
            suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1]) + 1) : '1';
            build++;
            break;
          }
          build = 0;
          patch = String(Number.parseInt(patch) + 1);
          break;
        default:
          build++;
          break;
      }
      let newSuffix = suffix.length > 0 ?
        '-' + suffix.join('.') :
        '';
      const newPVersion = `${major}.${minor}.${patch}${newSuffix}`;
      setTagValue(xml, 'Version', newPVersion);
      const newAVersion = `${major}.${minor}.${patch}.${build}`;
      setTagValue(xml, 'AssemblyVersion', newAVersion);
      setOrAddTagValue(xml, 'FileVersion', newAVersion, 'AssemblyVersion');
      const builder = new XMLBuilder({
        preserveOrder: true,
        commentPropName: "#comment",
        ignoreAttributes: false,
        format: true,
        indentBy: '  ',
        suppressEmptyNode: true,
      });
      const serialized = builder.build(xml).trimStart();
      const eol = rawxml.endsWith('\r\n') ? '\r\n' : (rawxml.endsWith('\n') ? '\n' : '');
      const output = serialized.endsWith('\n') ? serialized : serialized + eol;
      writeFileSync(path, '\ufeff' + output, 'utf-8');
    }
    execSync('git config user.name "github-actions[bot]"', { stdio: 'inherit' });
    execSync('git config user.email "41898282+github-actions[bot]@://github.com"', { stdio: 'inherit' });
    execSync('git add .', { stdio: 'inherit' });

    const status = execSync('git status --porcelain').toString();
    if (status.length > 0) {
      execSync('git commit -m "ci: update version number"', { stdio: 'inherit' });
      execSync('git push', { stdio: 'inherit' });
      core.info('Successfully committed and pushed changes.');
    } else {
      core.info('No changes to commit.');
    }

    core.setOutput('release-type', releaseType);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
