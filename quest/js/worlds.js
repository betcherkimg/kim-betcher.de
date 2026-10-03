/* Zwei Welten; Levelinhalte und der gemeinsame Spielstand bleiben unabhängig davon. */
export const WORLDS = [
  {
    id: 'vermittlung', name: 'Vermittlerreich', firstLevel: 1, lastLevel: 12,
    image: 'assets/world/quest-map.webp',
    coords: {
      1: [23.13,62.27], 2: [11.31,43.96], 3: [12.53,14.67],
      4: [35.05,17.39], 5: [66.31,16.83], 6: [86.81,18.26],
      7: [88.93,45.06], 8: [82.61,63.70], 9: [90.32,82.41],
      10: [67.63,80.61], 11: [43.53,79.94], 12: [52.02,46.63],
    },
    path: 'M387 586 C320 540 245 480 189 414 C176 330 184 220 209 138 C320 118 455 128 586 164 C760 120 935 118 1109 158 C1240 112 1370 124 1451 172 C1515 250 1520 340 1487 424 C1470 490 1435 548 1381 599 C1465 646 1520 710 1510 775 C1400 830 1250 820 1131 759 C1000 835 850 830 728 752 C700 650 780 520 870 439',
  },
  {
    id: 'kredit', name: 'Kreditreich', firstLevel: 13, lastLevel: 24,
    image: 'assets/world/quest-map-13-24.webp',
    // Zentren der zwölf roten Orientierungspunkte, in Prozent des Bildes.
    coords: Object.fromEntries([
      [13,485.3,684.1], [14,159.5,425.1], [15,229.2,168.3],
      [16,686.3,166.6], [17,1118.3,172.7], [18,1499.5,167.0],
      [19,1508.0,791.6], [20,1152.4,751.4], [21,774.4,694.1],
      [22,510.5,405.7], [23,907.6,439.7], [24,1440.7,486.2],
    ].map(([level,x,y]) => [level,[x/1672*100,y/941*100]])),
    path: 'M485.3 684.1 C360 650 270 520 159.5 425.1 C120 320 155 235 229.2 168.3 C380 90 530 95 686.3 166.6 C820 100 970 105 1118.3 172.7 C1240 115 1380 110 1499.5 167.0 C1600 220 1645 330 1645 465 C1660 640 1630 740 1508.0 791.6 C1400 875 1260 850 1152.4 751.4 C1045 825 910 810 774.4 694.1 C650 640 560 535 510.5 405.7 C640 450 760 485 907.6 439.7 C1070 450 1285 555 1440.7 486.2',
  },
];

export const worldForLevel = (level) => WORLDS.find((w) => level >= w.firstLevel && level <= w.lastLevel);

/** Noch nicht produzierte Level sind reine Vorschauen ohne erfundene Kapitel-IDs. */
export function chaptersForWorld(world, manifest) {
  return Array.from({length:world.lastLevel-world.firstLevel+1},(_,i) => {
    const level=world.firstLevel+i;
    return manifest.chapters.find((chapter) => chapter.level===level)
      || {id:null,level,title:'In Vorbereitung',available:false,boss:null};
  });
}

/** Bereits abgeschlossene Levels bleiben abgeschlossen, auch nach einem späteren GAME OVER. */
export function levelWasCompleted(progress) {
  return progress?.levelCompleted === true || !!progress?.coinFirst?.includes('level');
}

/** Alte Spielstände: tatsächlich gespielte Inhalte behalten ihren Zugang. Leere Einträge zählen nicht. */
export function hasChapterProgress(progress) {
  if (!progress) return false;
  return progress.unlocked === true || levelWasCompleted(progress)
    || ['storyWins', 'versusWins', 'bossWins', 'bestStory', 'bestVersus', 'bestBoss', 'bestCarousel'].some(key => progress[key] > 0)
    || ['learnCompleted', 'checksDone', 'learnXp', 'coinFirst'].some(key => progress[key]?.length > 0)
    || Object.values(progress.mistakes || {}).some(count => count > 0);
}

/** Jede Welt hat ihren eigenen Start und ihre eigene Freischaltungskette. */
export function isChapterUnlocked(chapter, manifest, state) {
  if (!chapter?.available) return false;
  const world = worldForLevel(chapter.level);
  if (!world) return false;
  if (chapter.level === world.firstLevel) return true;
  if (hasChapterProgress(state?.progress?.[chapter.id]) || state?.player?.openRun?.chapter === chapter.id) return true;
  const previous = manifest?.chapters?.find(c => c.level === chapter.level - 1);
  return !!previous && levelWasCompleted(state?.progress?.[previous.id]);
}
