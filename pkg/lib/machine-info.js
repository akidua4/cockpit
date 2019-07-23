/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2018 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

import cockpit from "cockpit";
const _ = cockpit.gettext;

var cpu_ram_info_promises = { };

export function cpu_ram_info(address) {
    var pr = cpu_ram_info_promises[address];
    var dfd;
    if (!pr) {
        dfd = cockpit.defer();
        cpu_ram_info_promises[address] = pr = dfd.promise();

        cockpit.spawn(["cat", "/proc/meminfo", "/proc/cpuinfo"], { host: address })
                .done(function(text) {
                    var info = { };
                    var match = text.match(/MemTotal:[^0-9]*([0-9]+) [kK]B/);
                    var total_kb = match && parseInt(match[1], 10);
                    if (total_kb)
                        info.memory = total_kb * 1024;
                    var swap_match = text.match(/SwapTotal:[^0-9]*([0-9]+) [kK]B/);
                    var swap_total_kb = swap_match && parseInt(swap_match[1], 10);
                    if (swap_total_kb)
                        info.swap = swap_total_kb * 1024;

                    match = text.match(/^model name\s*:\s*(.*)$/m);
                    if (match)
                        info.cpu_model = match[1];

                    info.cpus = 0;
                    var re = /^processor/gm;
                    while (re.test(text))
                        info.cpus += 1;
                    dfd.resolve(info);
                })
                .fail(function() {
                    dfd.reject();
                });
    }
    return pr;
}

// https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_2.7.1.pdf
const chassis_types = [
    undefined,
    _("Other"),
    _("Unknown"),
    _("Desktop"),
    _("Low Profile Desktop"),
    _("Pizza Box"),
    _("Mini Tower"),
    _("Tower"),
    _("Portable"),
    _("Laptop"),
    _("Notebook"),
    _("Hand Held"),
    _("Docking Station"),
    _("All In One"),
    _("Sub Notebook"),
    _("Space-saving Computer"),
    _("Lunch Box"), /* 0x10 */
    _("Main Server Chassis"),
    _("Expansion Chassis"),
    _("Sub Chassis"),
    _("Bus Expansion Chassis"),
    _("Peripheral Chassis"),
    _("RAID Chassis"),
    _("Rack Mount Chassis"),
    _("Sealed-case PC"),
    _("Multi-system Chassis"),
    _("Compact PCI"), /* 0x1A */
    _("Advanced TCA"),
    _("Blade"),
    _("Blade enclosure"),
    _("Tablet"),
    _("Convertible"),
    _("Detachable"), /* 0x20 */
    _("IoT Gateway"),
    _("Embedded PC"),
    _("Mini PC"),
    _("Stick PC"),
];

function parseDMIFields(text) {
    var info = {};
    text.split("\n").map(line => {
        let sep = line.indexOf(':');
        if (sep <= 0)
            return;
        let key = line.slice(0, sep).slice(line.lastIndexOf('/') + 1);
        let value = line.slice(sep + 1);
        info[key] = value;

        if (key === "chassis_type")
            info[key + "_str"] = chassis_types[parseInt(value)] || chassis_types[2]; // fall back to "Unknown"
    });
    return info;
}

var dmi_info_promises = { };

export function dmi_info(address) {
    var pr = dmi_info_promises[address];
    var dfd;
    if (!pr) {
        dfd = cockpit.defer();
        dmi_info_promises[address] = pr = dfd.promise();

        cockpit.spawn(["grep", "-r", ".", "/sys/class/dmi/id"], { err: "message", superuser: "try" })
                .done(output => dfd.resolve(parseDMIFields(output)))
                .fail((exception, output) => {
                    // the grep often/usually exits with 2, that's okay as long as we find *some* information
                    if (!exception.problem && output)
                        dfd.resolve(parseDMIFields(output));
                    else
                        dfd.reject(exception.message);
                });
    }
    return pr;
}

/* we expect udev db paragraphs like this:
 *
   P: /devices/virtual/mem/null
   N: null
   E: DEVMODE=0666
   E: DEVNAME=/dev/null
   E: SUBSYSTEM=mem
*/

const udevPathRE = /^P: (.*)$/;
const udevPropertyRE = /^E: (\w+)=(.*)$/;

function parseUdevDB(text) {
    var info = {};
    text.split("\n\n").map(paragraph => {
        let syspath = null;
        let props = {};

        paragraph = paragraph.trim();
        if (!paragraph)
            return;

        paragraph.split("\n").map(line => {
            let match = line.match(udevPathRE);
            if (match) {
                syspath = match[1];
            } else {
                match = line.match(udevPropertyRE);
                if (match)
                    props[match[1]] = match[2];
            }
        });

        if (syspath)
            info[syspath] = props;
        else
            console.log("udev database paragraph is missing P:", paragraph);
    });
    return info;
}

var udev_info_promises = { };

export function udev_info(address) {
    var pr = udev_info_promises[address];
    var dfd;
    if (!pr) {
        dfd = cockpit.defer();
        udev_info_promises[address] = pr = dfd.promise();

        cockpit.spawn(["udevadm", "info", "--export-db"], { err: "message" })
                .done(output => dfd.resolve(parseUdevDB(output)))
                .fail(exception => dfd.reject(exception.message));
    }
    return pr;
}

const memoryRE = /^([ \w]+): (.*)/;
var phys_locator_mapping = {};

// Process the dmidecode output and create a mapping of locator to DIMM properties
function parseMemoryInfo(text) {
    var info = {};
    text.split("\n\n").map(paragraph => {
        let locator = null;
        let props = {};
        // let handle= null;
        paragraph = paragraph.trim();
        if (!paragraph)
            return;

        paragraph.split("\n").map(line => {
            line = line.trim();
            let match = line.match(memoryRE);
            let match_handle = line.match("Handle ");
            if (match)
                props[match[1]] = match[2];

            if (match_handle) {
                props["Handle"] = match_handle["input"].split(",")[0].split(" ")[1];
            }
        });

        locator = props["Locator"];
        if (locator && props["Handle"]) {
            phys_locator_mapping[props["Handle"]] = locator;
        }
        if (locator)
            info[locator] = props;
    });
    return processMemory(info);
}
console.log(phys_locator_mapping);
// Select the useful properties to display
function processMemory(info) {
    let memoryArray = [];

    for (let dimm in info) {
        let memoryProperty = info[dimm];

        let memorySize = memoryProperty["Size"];
        if (memorySize.includes("MB")) {
            let memorySizeValue = parseInt(memorySize, 10);
            memorySize = memorySizeValue / 1024 + " GB";
        }

        let memoryTechnology = memoryProperty["Memory Technology"];
        if (!memoryTechnology || memoryTechnology == "<OUT OF SPEC>")
            memoryTechnology = _("Unknown");

        let memoryRank = memoryProperty["Rank"];
        if (memoryRank == 1)
            memoryRank = _("Single Rank");
        if (memoryRank == 2)
            memoryRank = _("Dual Rank");

        memoryArray.push({
            locator: memoryProperty["Locator"],
            technology: memoryTechnology,
            type: memoryProperty["Type"],
            size: memorySize,
            state: memoryProperty["Total Width"] == "Unknown" ? _("Absent") : _("Present"),
            rank: memoryRank,
            speed: memoryProperty["Speed"]
        });
    }

    return memoryArray;
}

var memory_info_promises = {};

export function memory_info(address) {
    var pr = memory_info_promises[address];

    if (!pr) {
        memory_info_promises[address] = pr = new Promise((resolve, reject) => {
            cockpit.spawn(["dmidecode", "-t", "memory"],
                          { environ: ["LC_ALL=C"], err: "message", superuser: "try" })
                    .done(output => resolve(parseMemoryInfo(output)))
                    .fail(exception => reject(exception.message));
        });
    }

    return pr;
}

function parsePersistentMemoryInfo(text) {
    if (text == "") return {};
    let textObject = JSON.parse(text);
    let regionsArray = [];
    let dimm_nspace_mapping = {};
    let sizeRE = /\(([^)]+)\)/;

    if (textObject.dimms.length > 0) {
        for (let dimm in textObject.dimms) {
            let phys_id = textObject.dimms[dimm]["phys_id"];
            let nspace = textObject.dimms[dimm]["dev"];
            dimm_nspace_mapping[nspace] = phys_locator_mapping[phys_id];
        }
    }
    if (textObject.regions.length > 0) {
        for (let region in textObject.regions) {
            let pmRegionName = textObject.regions[region]["dev"];
            let pmSize = textObject.regions[region]["size"].match(sizeRE)[1];
            let pmType = textObject.regions[region]["type"];
            let pmNamespaces = textObject.regions[region]["mappings"];
            let namespaceArray = [];
            let namespaceStr = "";
            let dimmStr = "";

            for (let namespace in pmNamespaces) {
                let name_space = pmNamespaces[namespace]["dimm"];
                if ((parseInt(namespace) + 1) == pmNamespaces.length) namespaceStr = namespaceStr + name_space;
                else namespaceStr = namespaceStr + name_space + "  ,  ";

                if (dimm_nspace_mapping[name_space]) {
                    if ((parseInt(namespace) + 1) == pmNamespaces.length) dimmStr = dimmStr + dimm_nspace_mapping[name_space];
                    else dimmStr = dimmStr + dimm_nspace_mapping[name_space] + "  ,  ";
                }
                namespaceArray.push({
                    dev: pmNamespaces[namespace]["dimm"],
                });
            }

            regionsArray.push({
                regionName: pmRegionName,
                size: pmSize,
                type: pmType,
                nmspaces: namespaceStr,
                dimms: dimmStr
            });
        }
    }

    return { "pmem_array": regionsArray };
}

var persistent_memory_info_promises = {};

export function persistent_memory_info(address) {
    var pr = persistent_memory_info_promises[address];

    if (!pr) {
        memory_info_promises[address] = pr = new Promise((resolve, reject) => {
            cockpit.spawn(["/usr/bin/ndctl", "list", "-DHNRu"],
                          { environ: ["LC_ALL=C"], err: "message", superuser: "try" })
                    .done(output => resolve(parsePersistentMemoryInfo(output)))
                    .fail(exception => reject(exception.message));
        });
    }

    return pr;
}

function parseControllerInfo(text) {
    if (text == "") return {};
    let textObject = JSON.parse(text);
    let controllerArray = [];

    if (textObject.Controllers[0]["Response Data"]["Number of Controllers"] == 0) {
        return {};
    } else {
        let system_overview = textObject.Controllers[0]["Response Data"]["System Overview"];
        for (let elem in system_overview) {
            let contModel = system_overview[elem]["Model"];
            let contPorts = system_overview[elem]["Ports"];
            let contPd = system_overview[elem]["PDs"];
            let contVd = system_overview[elem]["VDs"];
            let contBbu = system_overview[elem]["BBU"] == "Msng" ? _("Missing") : system_overview[elem]["BBU"];
            let contSpr = system_overview[elem]["sPR"];
            let contHealth = system_overview[elem]["Hlth"] == "Opt" ? _("Optimal") : system_overview[elem]["BBU"];

            controllerArray.push({
                model: contModel,
                ports: contPorts,
                PD: contPd,
                VD: contVd,
                BBU: contBbu,
                SPR: contSpr,
                health: contHealth
            });
        }
    }
    return { "cont_array": controllerArray };
}

var controller_info_promises = {};

export function controller_info(address) {
    var pr = controller_info_promises[address];

    if (!pr) {
        memory_info_promises[address] = pr = new Promise((resolve, reject) => {
            cockpit.spawn(["/opt/MegaRAID/perccli/perccli64", "show", "j"],
                          { environ: ["LC_ALL=C"], err: "message", superuser: "try" })
                    .done(output => resolve(parseControllerInfo(output)))
                    .fail(exception => reject(exception.message));
        });
    }

    return pr;
}
