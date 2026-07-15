import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useListLore, type LoreEntrySummary } from "@workspace/api-client-react";
import { districtLabel, type DistrictValue } from "@/lib/districts";
import mapImage from "@assets/image_1784075731682.png";

// Polygons are machine-traced against the source map image
// (attached_assets/image_1784075731682.png, 3825x3699 px) by masking each
// district's colored border, flood-filling the enclosed region, and tracing
// the contour, so hover boundaries follow the drawn borders exactly.
// Coordinates are in the image's native pixel space; the SVG viewBox keeps
// them aligned at any rendered size.
const VIEW_W = 3825;
const VIEW_H = 3699;

type DistrictShape = {
  value: DistrictValue;
  color: string;
  labelPos: [number, number];
  points: string;
};

const DISTRICT_SHAPES: DistrictShape[] = [
  {
    value: "watson",
    color: "#ef4444",
    labelPos: [1457, 728],
    points:
      "1640,238 1802,269 1892,332 2042,712 1988,757 1954,824 1954,877 1919,932 1872,963 1796,990 1787,982 1710,1054 1710,1149 1681,1180 1680,1233 1661,1252 1671,1263 1662,1283 1642,1303 1568,1308 1284,1303 1264,1283 1198,1043 889,951 864,929 901,610 922,589 1146,449 1159,459 1175,443 1340,431 1440,320 1639,239",
  },
  {
    value: "westbrook",
    color: "#f97316",
    labelPos: [2054, 1269],
    points:
      "2029,719 2050,739 2064,787 2126,889 2178,954 2209,916 2237,906 2234,873 2268,839 2347,838 2388,846 2454,901 2496,917 2538,959 2483,1043 2475,1115 2439,1151 2409,1150 2433,1174 2430,1393 2366,1443 2280,1464 2239,1506 2366,1639 2390,1761 2353,1797 2193,1827 1996,1704 1968,1712 1898,1651 1890,1632 1900,1610 1882,1628 1778,1532 1764,1468 1646,1294 1672,1247 1672,1182 1699,1154 1699,1059 1786,983 1909,938 1942,882 1962,862 1973,871 1967,840 1948,820 1974,764 2028,720",
  },
  {
    value: "city_center",
    color: "#eab308",
    labelPos: [1364, 1523],
    points:
      "1060,1296 1156,1383 1276,1296 1530,1302 1550,1322 1548,1405 1526,1427 1547,1448 1548,1488 1665,1577 1644,1598 1647,1634 1621,1709 1571,1753 1503,1756 1438,1699 1402,1620 1388,1629 1091,1618 1068,1594 1034,1473 965,1396 1059,1297",
  },
  {
    value: "beastside",
    color: "#f0f",
    labelPos: [1633, 1344],
    points:
      "1629,1297 1673,1332 1769,1466 1788,1544 1909,1664 1702,1942 1680,1964 1660,1944 1608,1717 1635,1634 1633,1605 1674,1581 1540,1479 1543,1323 1564,1302 1628,1298",
  },
  {
    value: "heywood",
    color: "#22c55e",
    labelPos: [1400, 1821],
    points:
      "1629,1297 1673,1332 1769,1466 1788,1544 1909,1665 1588,2097 1566,2119 1327,2124 1313,2111 1300,2124 1190,2127 1055,2071 1031,2048 1059,1627 1079,1607 1312,1615 1327,1630 1340,1617 1402,1618 1449,1704 1492,1742 1566,1744 1609,1722 1633,1605 1674,1581 1540,1479 1543,1323 1564,1302 1628,1298",
  },
  {
    value: "santo_domingo",
    color: "#3b82f6",
    labelPos: [2036, 2056],
    points:
      "1906,1661 1969,1710 1990,1697 2185,1825 2390,1784 2458,1850 2464,1928 2397,2285 2340,2352 2308,2425 2287,2446 2264,2449 1920,2459 1868,2424 1849,2427 1825,2394 1661,2268 1610,2186 1571,2157 1566,2114 1905,1662",
  },
  {
    value: "pacifica",
    color: "#a855f7",
    labelPos: [1214, 2358],
    points:
      "1042,2053 1183,2123 1192,2114 1561,2107 1581,2127 1584,2162 1627,2195 1632,2211 1616,2227 1726,2318 1686,2405 1648,2442 1555,2468 1556,2532 1500,2588 1353,2646 1252,2742 1051,2690 978,2617 991,2602 968,2609 923,2567 887,2589 865,2567 751,2350 967,2163 1041,2054",
  },
  {
    value: "north_badlands",
    color: "#64748b",
    labelPos: [1103, 179],
    points:
      "0,0 3824,0 3824,1357 3771,1336 3778,1241 3440,372 3391,350 3511,926 3531,1389 3789,2198 3789,2357 3769,2377 3711,2301 3546,2385 2728,2439 2638,2436 2609,2404 2687,1990 2729,1492 2609,1151 2482,1043 2533,958 2425,857 2343,846 2246,849 2243,888 2166,940 2058,785 1879,324 1801,277 1646,247 1445,325 1337,442 1150,454 912,604 875,936 1190,1031 1276,1294 1160,1386 1065,1301 1028,1298 895,1510 567,1819 0,2242 0,1",
  },
  {
    value: "eastern_badlands",
    color: "#0ea5e9",
    labelPos: [3193, 1399],
    points:
      "2949,59 3392,351 3511,926 3531,1389 3789,2198 3789,2357 3769,2377 3711,2301 3546,2385 2728,2439 2638,2436 2609,2407 2687,1990 2726,1483 2609,1151 2482,1043 2532,956 2425,857 2343,846 2246,849 2243,888 2166,940 2058,785 1901,383 1967,350 2536,292 2948,60",
  },
  {
    value: "southern_badlands",
    color: "#78716c",
    labelPos: [1718, 3283],
    points:
      "963,1396 1043,1481 1081,1610 1046,2054 979,2159 761,2347 880,2578 922,2557 1049,2682 1258,2735 1358,2637 1507,2577 1548,2536 1545,2486 1667,2430 1732,2312 1912,2446 2284,2433 2313,2563 2341,2554 2378,2608 2484,2597 2616,2498 2609,2453 2642,2420 2716,2416 2743,2443 2774,2414 3569,2362 3708,2284 3824,2413 3824,3698 0,3698 0,2231 529,1847 877,1513 962,1397",
  },
];


export default function CityMap() {
  const [, navigate] = useLocation();
  const { data: entries, isLoading } = useListLore();
  const [hovered, setHovered] = useState<DistrictValue | null>(null);

  const byDistrict = useMemo(() => {
    const map = new Map<string, LoreEntrySummary>();
    for (const e of entries ?? []) {
      if (e.district && !map.has(e.district)) map.set(e.district, e);
    }
    return map;
  }, [entries]);

  const hoveredEntry = hovered ? byDistrict.get(hovered) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="font-mono text-xs text-muted-foreground">
          Hover a district to highlight it. Click to open its lore entry.
        </p>
        <div className="font-mono text-xs border border-border bg-card/50 px-3 py-2 min-w-[220px]" data-testid="text-map-hover-info">
          {hovered ? (
            <>
              <span className="font-display tracking-widest text-nc-cyan">{districtLabel(hovered)}</span>
              <span className="text-muted-foreground ml-2">
                {hoveredEntry ? `→ ${hoveredEntry.name}` : isLoading ? "Loading lore..." : "No lore entry tagged yet"}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Hover a district...</span>
          )}
        </div>
      </div>

      <div className="relative border border-nc-cyan/20 bg-card/30 p-1">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block"
          role="img"
          aria-label="Interactive map of Night City districts"
          data-testid="svg-night-city-map"
        >
          <image href={mapImage} x={0} y={0} width={VIEW_W} height={VIEW_H} />
          {DISTRICT_SHAPES.map((d) => {
            const entry = byDistrict.get(d.value);
            const isHovered = hovered === d.value;
            return (
              <g key={d.value}>
                <polygon
                  points={d.points}
                  fill={d.color}
                  fillOpacity={isHovered ? 0.28 : 0}
                  stroke={d.color}
                  strokeOpacity={isHovered ? 0.9 : 0}
                  strokeWidth={12}
                  className={entry ? "cursor-pointer" : "cursor-default"}
                  style={{ transition: "fill-opacity 150ms, stroke-opacity 150ms" }}
                  onMouseEnter={() => setHovered(d.value)}
                  onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
                  onClick={() => {
                    if (entry) navigate(`/directory/lore/${entry.id}`);
                  }}
                  data-testid={`polygon-district-${d.value}`}
                />
                {isHovered && (
                  <MapTooltip color={d.color} labelPos={d.labelPos} title={districtLabel(d.value)?.toUpperCase() ?? ""} entry={entry} />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {DISTRICT_SHAPES.map((d) => {
          const entry = byDistrict.get(d.value);
          const inner = (
            <div
              className={`border px-3 py-2 font-mono text-xs flex items-center gap-2 ${entry ? "cursor-pointer hover:bg-card" : "opacity-60"}`}
              style={{ borderColor: d.color }}
              onMouseEnter={() => setHovered(d.value)}
              onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
              data-testid={`card-district-${d.value}`}
            >
              <span className="w-2 h-2 shrink-0" style={{ backgroundColor: d.color }} />
              <span className="truncate">
                {districtLabel(d.value)}
                <span className="text-muted-foreground"> — {entry ? entry.name : "no lore yet"}</span>
              </span>
            </div>
          );
          return entry ? (
            <Link key={d.value} href={`/directory/lore/${entry.id}`}>{inner}</Link>
          ) : (
            <div key={d.value}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}

function MapTooltip({
  color,
  labelPos,
  title,
  entry,
}: {
  color: string;
  labelPos: [number, number];
  title: string;
  entry?: LoreEntrySummary;
}) {
  return (
    <g pointerEvents="none">
      <rect
        x={labelPos[0] - 425}
        y={labelPos[1] - 98}
        width={850}
        height={entry ? 215 : 197}
        fill="#0a0a0a"
        fillOpacity={0.85}
        stroke={color}
        strokeWidth={4}
      />
      <text x={labelPos[0]} y={labelPos[1]} textAnchor="middle" fill={color} fontSize={90} fontFamily="monospace" fontWeight="bold">
        {title}
      </text>
      <text x={labelPos[0]} y={labelPos[1] + 85} textAnchor="middle" fill="#e5e5e5" fontSize={58} fontFamily="monospace">
        {entry ? `→ ${entry.name}` : "No lore entry yet"}
      </text>
    </g>
  );
}
