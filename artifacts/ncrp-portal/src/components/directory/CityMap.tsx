import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useListLore, type LoreEntrySummary } from "@workspace/api-client-react";
import { districtLabel, type DistrictValue } from "@/lib/districts";
import mapImage from "@assets/image_1784074406609.png";

// Polygons are machine-traced against the source map image
// (attached_assets/image_1784074406609.png, 4264x4128 px) by masking each
// district's colored border, flood-filling the enclosed region, and tracing
// the contour, so hover boundaries follow the drawn borders exactly.
// Coordinates are in the image's native pixel space; the SVG viewBox keeps
// them aligned at any rendered size.
const VIEW_W = 4264;
const VIEW_H = 4128;

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
    labelPos: [1624, 812],
    points:
      "1815,240 2001,274 2098,337 2126,413 2118,426 2161,496 2212,624 2203,654 2268,761 2231,793 2223,787 2199,818 2169,889 2169,951 2129,1014 1990,1074 1976,1060 1977,1076 1895,1150 1897,1263 1867,1293 1867,1357 1845,1372 1859,1386 1843,1413 1829,1427 1746,1433 1420,1427 1404,1409 1332,1151 1346,1129 1328,1139 976,1031 956,1015 996,658 1014,636 1267,476 1366,599 1282,486 1296,472 1483,460 1595,332 1814,241",
  },
  {
    value: "westbrook",
    color: "#f97316",
    labelPos: [2290, 1416],
    points:
      "2263,774 2293,847 2395,1009 2432,1032 2459,998 2496,989 2494,930 2510,914 2617,912 2703,924 2744,982 2792,1000 2834,1043 2773,1147 2763,1192 2771,1240 2751,1257 2695,1262 2713,1292 2711,1540 2627,1589 2544,1605 2494,1656 2634,1816 2666,1960 2652,1974 2443,2008 2394,1992 2218,1868 2194,1882 2117,1820 2109,1800 2121,1772 2101,1795 1978,1688 1962,1615 1837,1429 1866,1379 1866,1297 1898,1265 1900,1152 1983,1078 2132,1023 2130,1009 2168,959 2170,928 2184,914 2198,926 2172,889 2194,842 2262,775",
  },
  {
    value: "city_center",
    color: "#eab308",
    labelPos: [1520, 1700],
    points:
      "1169,1427 1276,1524 1413,1428 1703,1434 1717,1448 1715,1551 1697,1578 1711,1592 1711,1633 1855,1737 1812,1757 1825,1787 1793,1889 1742,1931 1662,1931 1602,1875 1563,1777 1549,1791 1201,1779 1186,1764 1148,1627 1065,1537 1168,1428",
  },
  {
    value: "beastside",
    color: "#f0f",
    labelPos: [1820, 1500],
    points:
      "1816,1428 1843,1443 1961,1619 1885,1725 1870,1740 1712,1626 1719,1448 1733,1434 1815,1429",
  },
  {
    value: "heywood",
    color: "#22c55e",
    labelPos: [1561, 2032],
    points:
      "1956,1637 1971,1652 1979,1697 2120,1830 1884,2150 1870,2164 1855,2151 1867,2175 1739,2340 1468,2344 1455,2331 1434,2346 1319,2348 1161,2284 1146,2269 1146,2245 1180,1795 1195,1780 1450,1788 1467,1804 1482,1790 1556,1792 1602,1880 1656,1930 1745,1931 1782,1904 1796,1916 1826,1789 1818,1767 1834,1752 1874,1745 1955,1638",
  },
  {
    value: "santo_domingo",
    color: "#3b82f6",
    labelPos: [2270, 2294],
    points:
      "2125,1833 2192,1887 2218,1874 2359,1975 2426,2006 2437,2028 2457,2010 2672,1977 2740,2044 2747,2123 2669,2532 2608,2602 2565,2691 2541,2707 2374,2717 2357,2701 2410,2672 2401,2663 2343,2705 2304,2705 2290,2691 2323,2660 2304,2606 2312,2640 2298,2663 2283,2678 2260,2665 2237,2674 2232,2682 2251,2697 2237,2711 2136,2721 2079,2687 2149,2604 2131,2594 2146,2609 2067,2689 1860,2512 1798,2420 1752,2389 1747,2338 2124,1834",
  },
  {
    value: "pacifica",
    color: "#a855f7",
    labelPos: [1353, 2632],
    points:
      "1149,2280 1297,2340 1310,2360 1330,2346 1734,2339 1749,2354 1749,2397 1787,2414 1819,2459 1804,2475 1778,2460 1837,2498 1899,2563 1905,2581 1887,2601 1879,2595 1889,2621 1865,2649 1864,2674 1828,2701 1757,2725 1741,2729 1723,2713 1717,2812 1700,2829 1679,2848 1647,2843 1609,2886 1507,2929 1400,3023 1366,3025 1347,3011 1324,3025 1276,3010 1262,2996 1309,2967 1326,2924 1249,2938 1230,2905 1207,2932 1189,2910 1194,2888 1166,2873 1187,2855 1141,2867 1127,2857 1068,2882 1011,2839 969,2862 830,2602 1072,2397 1148,2281",
  },
  {
    value: "north_badlands",
    color: "#64748b",
    labelPos: [1230, 200],
    points:
      "0,0 2175,0 2162,31 2236,74 2173,118 2172,147 2218,185 2288,172 2301,206 2335,186 2286,159 2274,0 4197,0 4263,31 4263,75 4200,95 4168,76 4199,45 4097,45 4038,164 3948,108 3920,125 3872,75 3884,44 3829,101 3792,84 3738,110 3753,127 3713,161 3790,206 3837,277 3879,248 3943,288 4059,272 4177,325 4228,289 4260,326 4230,350 4263,359 4263,1794 4228,2496 3989,2623 3116,2685 2923,2676 3020,2194 3061,1642 2923,1269 2781,1147 2856,992 2820,986 2798,943 2755,982 2734,902 2713,925 2540,907 2482,933 2427,894 2416,841 2382,877 2353,850 2315,862 2262,729 2330,714 2342,680 2252,597 2297,550 2349,622 2400,558 2296,506 2248,536 2135,424 2108,322 2004,273 1812,239 1586,333 1478,459 1267,473 998,643 955,1025 1317,1136 1408,1424 1280,1522 1167,1423 1058,1531 1147,1632 1190,1776 1148,2272 1075,2389 829,2598 946,2837 923,2870 1006,2851 1148,2979 1219,3001 1235,3018 1201,3078 1238,3103 1342,3057 1371,3077 1544,2917 1548,2962 1679,2969 1700,2926 1658,2905 1683,2864 1737,2917 1805,2895 1867,2807 1929,2779 1926,2723 1964,2680 1997,2711 2014,2681 2069,2698 1786,3217 1168,3991 1109,3967 1217,3895 1283,3777 1338,3741 1443,3572 1518,3504 1503,3476 1560,3451 1686,3296 1689,3257 1540,3332 1522,3391 1422,3498 1436,3517 1373,3561 1392,3596 1346,3671 1288,3734 1257,3727 1219,3798 1235,3818 1174,3866 1185,3887 1129,3893 1057,3986 371,3477 399,3438 362,3354 398,3358 384,3337 417,3324 351,3297 290,3225 358,3135 318,3160 123,3128 147,3190 130,3208 169,3246 93,3323 194,3400 218,3479 293,3474 385,3574 404,3544 443,3572 452,3635 503,3652 460,3702 489,3731 457,3766 500,3823 482,3864 515,3840 556,3932 621,3907 662,4019 626,4127 0,4127 0,1",
  },
  {
    value: "eastern_badlands",
    color: "#0ea5e9",
    labelPos: [3560, 1561],
    points:
      "3316,43 3576,208 3582,245 3600,232 3727,308 3761,338 3753,375 3802,357 3850,412 3852,573 3883,628 3760,709 3711,711 3816,689 3842,744 3900,762 3983,1387 4263,1474 4228,2496 3989,2623 3116,2685 2923,2676 3020,2194 3061,1642 2923,1269 2781,1147 2856,992 2820,986 2798,943 2755,982 2734,902 2713,925 2540,907 2482,933 2427,894 2416,841 2382,877 2353,850 2315,862 2262,729 2330,714 2342,680 2252,597 2297,550 2349,622 2400,558 2296,506 2248,536 2124,396 2839,312 3315,44",
  },
  {
    value: "southern_badlands",
    color: "#78716c",
    labelPos: [1915, 3664],
    points:
      "0,0 2175,0 2162,31 2236,74 2173,118 2172,147 2218,185 2288,172 2301,206 2335,186 2286,159 2274,0 4197,0 4263,31 4263,75 4200,95 4168,76 4199,45 4097,45 4038,164 3948,108 3920,125 3872,75 3884,44 3829,101 3792,84 3738,110 3753,127 3713,161 3790,206 3837,277 3879,248 3943,288 4059,272 4177,325 4228,289 4260,326 4230,351 4263,359 4263,1478 3979,1377 3882,658 3930,629 3903,614 3942,573 3869,530 3857,366 3320,48 2820,313 2401,360 2389,332 2361,364 2130,390 2108,322 2004,273 1812,239 1586,333 1478,459 1267,473 998,643 955,1025 1317,1136 1408,1424 1280,1522 1167,1423 1058,1531 1147,1632 1190,1776 1148,2272 1075,2389 829,2598 946,2837 923,2870 1006,2851 1148,2979 1219,3001 1235,3018 1201,3078 1238,3103 1342,3057 1371,3077 1544,2917 1548,2962 1679,2969 1700,2926 1658,2905 1683,2864 1737,2917 1805,2895 1867,2807 1929,2779 1926,2723 1964,2680 1997,2711 2014,2681 2069,2698 1786,3217 1168,3991 1109,3967 1217,3895 1283,3777 1338,3741 1443,3572 1518,3504 1503,3476 1560,3451 1686,3296 1689,3257 1540,3332 1522,3391 1422,3498 1436,3517 1373,3561 1392,3596 1346,3671 1288,3734 1257,3727 1219,3798 1235,3818 1174,3866 1185,3887 1129,3893 1057,3986 371,3477 399,3438 362,3354 398,3358 384,3337 417,3324 351,3297 290,3225 358,3135 318,3160 123,3128 147,3190 130,3208 169,3246 93,3323 194,3400 218,3479 293,3474 385,3574 404,3544 443,3572 452,3635 503,3652 460,3702 489,3731 457,3766 500,3823 482,3864 515,3840 556,3932 621,3907 662,4019 626,4127 0,4127 0,1",
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
