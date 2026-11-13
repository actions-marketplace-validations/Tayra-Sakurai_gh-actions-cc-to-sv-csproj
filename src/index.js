import * as core from "@actions/core";
import * as github from "@actions/github";
import { Bumper } from "conventional-recommended-bump";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import preset from "conventional-changelog-conventionalcommits";
import { XMLParser } from "fast-xml-parser";
import XMLBuilder from "fast-xml-builder";

/**
 * Finds nodes by tag name.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The searching tag name
 * @returns {*}
 */
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

/**
 * Finds an XML node object containing the specified tag name.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The searching tag name
 * @returns {object|null} The matching node object, or null if not found
 */
function findNode(nodes, tagName) {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (tagName in node) return node;
    for (const key of Object.keys(node)) {
      if (key !== ":@" && Array.isArray(node[key])) {
        const found = findNode(node[key], tagName);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Gets the text value of a tag.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The tag name
 * @returns {string|null} The text value of the tag, or null if not found
 */
function getTagValue(nodes, tagName) {
  const node = findTag(nodes, tagName);
  if (!node || !Array.isArray(node)) return null;
  const textObj = node.find((child) => "#text" in child);
  return textObj ? String(textObj["#text"]) : "";
}

/**
 * Sets the text value of a tag.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The tag name
 * @param {string} value The text value to set
 * @returns {boolean} True if the tag was found and updated, otherwise false
 */
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

/**
 * Sets the text value of a tag, or adds the tag after a specified sibling if it does not exist.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The tag name
 * @param {string} value The text value to set
 * @param {string|null} [nearTagName=null] The sibling tag name to insert after if tag does not exist
 * @returns {void}
 */
function setOrAddTagValue(nodes, tagName, value, nearTagName = null) {
  if (setTagValue(nodes, tagName, value)) return;
  if (nearTagName) {
    /**
     * Recursively searches for the nearTagName and inserts the new tag after it.
     * @param {*} list List of XML nodes
     * @returns {boolean} True if inserted, otherwise false
     */
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

/**
 * Gets an attribute value from a specified tag.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The tag name
 * @param {string} attributeName The attribute name
 * @returns {string|null} The attribute value, or null if not found
 */
function getTagAttribute(nodes, tagName, attributeName) {
  const node = findNode(nodes, tagName);
  if (!node || !node[":@"]) return null;
  const cleanAttr = attributeName.startsWith("@_") ? attributeName.slice(2) : attributeName;
  for (const key of Object.keys(node[":@"])) {
    const rawKey = key.startsWith("@_") ? key.slice(2) : key;
    if (rawKey.toLowerCase() === cleanAttr.toLowerCase()) {
      return String(node[":@"][key]);
    }
  }
  return null;
}

/**
 * Sets an attribute value on a specified tag.
 * @param {*} nodes Parsed XML data
 * @param {string} tagName The tag name
 * @param {string} attributeName The attribute name
 * @param {string} value The value to set
 * @returns {boolean} True if the tag was found and updated, otherwise false
 */
function setTagAttribute(nodes, tagName, attributeName, value) {
  const node = findNode(nodes, tagName);
  if (!node) return false;
  if (!node[":@"]) {
    node[":@"] = {};
  }
  const cleanAttr = attributeName.startsWith("@_") ? attributeName.slice(2) : attributeName;
  for (const key of Object.keys(node[":@"])) {
    const rawKey = key.startsWith("@_") ? key.slice(2) : key;
    if (rawKey.toLowerCase() === cleanAttr.toLowerCase()) {
      node[":@"][key] = value;
      return true;
    }
  }
  node[":@"][`@_${cleanAttr}`] = value;
  return true;
}

/**
 * Runs the GitHub Action to bump versions in project and manifest files.
 * @returns {Promise<void>}
 */
async function run() {
  try {
    const bumper = new Bumper();
    bumper.loadPreset('conventionalcommits', () => preset);
    const tag = core.getInput('tag');
    if (tag)
      bumper.tag(tag);
    const paths = core.getMultilineInput('path');
    const { level, releaseType } = await bumper.bump();

    /**
     * Common builder options.
     * @type {import("fast-xml-builder").XmlBuilderOptions}
     */
    const builderOptions = {
      preserveOrder: true,
      commentPropName: "#comment",
      ignoreAttributes: false,
      format: true,
      indentBy: '  ',
      suppressEmptyNode: true,
    };

    /**
     * Common parser options.
     * @type {import("fast-xml-parser").X2jOptions}
     */
    const parserOptions = {
      preserveOrder: true,
      commentPropName: "#comment",
      ignoreAttributes: false,
      parseTagValue: false,
    };

    /**
     * Whether the project package version has a suffix or not.
     * @type {boolean}
     */
    let hasSuffix = false;

    for (const path of paths) {
      const content = readFileSync(path, 'utf-8');
      core.info(content);
      const rawxml = content.replace(/^\ufeff/, '');
      const parser = new XMLParser(parserOptions);
      const xml = parser.parse(rawxml);
      const versionTagP = getTagValue(xml, 'Version');
      const versionTagA = getTagValue(xml, 'AssemblyVersion');
      if (!versionTagP || !versionTagA) {
        throw new Error(`Version or AssemblyVersion not found in ${path}`);
      }
      let [ major, minor, patch, ...suffix ] = versionTagP.split(/\.|-/);
      let build = Number.parseInt(versionTagA.split(/\D/)[3]);
      hasSuffix ||= suffix.length > 0;
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
          if (suffix.length > 0) {
            suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1]) + 1) : '1';
            build++;
            break;
          }
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
      const builder = new XMLBuilder(builderOptions);
      const serialized = builder.build(xml).trimStart();
      const eol = rawxml.endsWith('\r\n') ? '\r\n' : (rawxml.endsWith('\n') ? '\n' : '');
      const output = serialized.endsWith('\n') ? serialized : serialized + eol;
      core.info(`Output:\n${output}`);
      writeFileSync(path, '\ufeff' + output, 'utf-8');
    }

    const appxmanifestPaths = core.getMultilineInput('appxmanifestpath');

    for (const appxmanifestPath of appxmanifestPaths) {
      const appxmanifestcontent = readFileSync(appxmanifestPath, 'utf8');
      core.info(appxmanifestcontent);
      const xmlText = appxmanifestcontent.replace(/^\ufeff/, '');
      const parser = new XMLParser(parserOptions);
      const node = parser.parse(xmlText);
      const version = getTagAttribute(node, 'Identity', 'Version') ?? getTagAttribute(node, 'assemblyIdentity', 'version');
      if (!version) {
        throw new Error(`Identity Version not found in ${appxmanifestPath}`);
      }
      let [ major, minor, patch, ...rest ] = version.split(/\.|-/);
      let build = Number.parseInt(rest[0], 10);
      if (Number.isNaN(build)) build = 0;
      let suffix = rest.slice(1);
      if (!hasSuffix) {
        switch (level) {
          case 0:
            if (suffix.length > 0) {
              suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1], 10) + 1) : '1';
              build++;
              break;
            }
            build = 0;
            minor = '0';
            patch = '0';
            major = String(Number.parseInt(major, 10) + 1);
            break;
          case 1:
            if (suffix.length > 0) {
              suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1], 10) + 1) : '1';
              build++;
              break;
            }
            build = 0;
            patch = '0';
            minor = String(Number.parseInt(minor, 10) + 1);
            break;
          case 2:
            if (suffix.length > 0) {
              suffix[1] = suffix.length >= 2 ? String(Number.parseInt(suffix[1], 10) + 1) : '1';
              build++;
              break;
            }
            build = 0;
            patch = String(Number.parseInt(patch, 10) + 1);
            break;
          default:
            build++;
            break;
        }
      } else {
        build++;
      }
      let newSuffix = suffix.length > 0 ?
        '-' + suffix.join('.') :
        '';
      const newVersion = `${major}.${minor}.${patch}.${build}${newSuffix}`;
      if (findTag(node, 'Identity'))
        setTagAttribute(node, 'Identity', 'Version', newVersion);
      else
        setTagAttribute(node, 'assemblyIdentity', 'version', newVersion);
      const builder = new XMLBuilder(builderOptions);
      const serialized = builder.build(node).trimStart();
      const eol = xmlText.endsWith('\r\n') ? '\r\n' : (xmlText.endsWith('\n') ? '\n' : '');
      const output = serialized.endsWith('\n') ? serialized : serialized + eol;
      core.info(`Output:\n${output}`);
      writeFileSync(appxmanifestPath, '\ufeff' + output, 'utf-8');
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
