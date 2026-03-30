import Foundation

/// Fuzzy-searches SF Symbol names against a keyword map and symbol list.
enum SFSymbolSearchService {

    /// Returns up to `limit` SF Symbol names matching `query`, scored by exact (10), prefix (6), and substring (3) keyword matches
    /// plus symbol-name matches (exact 8, substring 4). Falls back to `defaults` if fewer than 6 results.
    static func suggestIcons(for query: String, defaults: [String]? = nil, limit: Int = 24) -> [String] {
        let fallback = defaults ?? defaultLocationIcons
        let normalizedQuery = query.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return fallback }

        var scored: [String: Int] = [:]

        let queryWords = normalizedQuery.split(separator: " ").map(String.init)

        for (keyword, icons) in keywordMap {
            for word in queryWords {
                if keyword == word {
                    for icon in icons { scored[icon, default: 0] += 10 }
                } else if keyword.hasPrefix(word) || word.hasPrefix(keyword) {
                    for icon in icons { scored[icon, default: 0] += 6 }
                } else if keyword.contains(word) || word.contains(keyword) {
                    for icon in icons { scored[icon, default: 0] += 3 }
                }
            }
        }

        for symbol in allSearchableSymbols {
            let symbolLower = symbol.lowercased()
            for word in queryWords {
                if symbolLower == word {
                    scored[symbol, default: 0] += 8
                } else if symbolLower.contains(word) {
                    scored[symbol, default: 0] += 4
                }
            }
        }

        let results = scored.sorted { $0.value > $1.value }.map(\.key)

        if results.count >= 6 {
            return Array(results.prefix(limit))
        }

        var combined = results
        for icon in fallback where !combined.contains(icon) {
            combined.append(icon)
            if combined.count >= limit { break }
        }
        return Array(combined.prefix(limit))
    }

    // MARK: - Defaults

    static let defaultGroupIcons: [String] = [
        "folder", "person.2", "person.3", "star",
        "heart", "briefcase", "sportscourt", "music.note",
        "graduationcap", "gamecontroller", "fork.knife", "airplane",
        "paintbrush", "book", "leaf", "figure.run",
        "camera", "dumbbell", "bicycle", "trophy",
        "sparkles", "flag", "gift", "cup.and.saucer"
    ]

    static let defaultLocationIcons: [String] = [
        "mappin", "building.2", "house", "globe",
        "airplane", "fork.knife", "briefcase", "graduationcap",
        "storefront", "bed.double", "sportscourt", "tree",
        "star", "heart", "flag", "pin",
        "mountain.2", "beach.umbrella", "cup.and.saucer", "dumbbell",
        "building.columns", "tent", "ferry", "camera"
    ]

    // MARK: - All Searchable Symbols

    private static let allSearchableSymbols: [String] = Array(Set(
        keywordMap.values.flatMap { $0 } + defaultLocationIcons
    )).sorted()

    // MARK: - Keyword Map

    private static let keywordMap: [String: [String]] = [
        // --- General place types ---
        "city": ["building.2", "building", "building.columns", "globe"],
        "town": ["building.2", "house", "storefront"],
        "village": ["house", "tree", "leaf"],
        "downtown": ["building.2", "building", "storefront"],
        "urban": ["building.2", "building"],
        "suburb": ["house", "car", "tree"],
        "country": ["globe", "flag", "tree"],
        "state": ["globe", "flag", "mappin"],
        "neighborhood": ["house", "mappin", "person.2"],

        // --- Accommodations ---
        "home": ["house", "house.fill"],
        "house": ["house", "house.fill"],
        "apartment": ["building.2", "building"],
        "condo": ["building.2", "building"],
        "hotel": ["bed.double", "building.2", "key"],
        "motel": ["bed.double", "car"],
        "hostel": ["bed.double", "person.3"],
        "resort": ["bed.double", "sun.max", "beach.umbrella"],
        "airbnb": ["bed.double", "house", "key"],
        "cabin": ["house.lodge", "tree", "flame"],
        "camp": ["tent", "flame", "leaf"],
        "camping": ["tent", "flame", "mountain.2"],
        "tent": ["tent", "leaf"],

        // --- Food & drink ---
        "restaurant": ["fork.knife", "cup.and.saucer"],
        "food": ["fork.knife", "cart"],
        "dining": ["fork.knife", "wineglass"],
        "eat": ["fork.knife"],
        "lunch": ["fork.knife", "cup.and.saucer"],
        "dinner": ["fork.knife", "wineglass"],
        "breakfast": ["cup.and.saucer", "fork.knife"],
        "brunch": ["cup.and.saucer", "fork.knife"],
        "cafe": ["cup.and.saucer", "mug"],
        "coffee": ["cup.and.saucer", "mug"],
        "tea": ["cup.and.saucer", "leaf"],
        "bar": ["wineglass", "music.note"],
        "pub": ["wineglass", "mug"],
        "club": ["music.note", "sparkles", "star"],
        "lounge": ["wineglass", "music.note"],
        "brewery": ["mug", "drop"],
        "winery": ["wineglass", "leaf"],
        "bakery": ["fork.knife", "storefront"],
        "pizza": ["fork.knife", "flame"],
        "sushi": ["fork.knife"],
        "grill": ["fork.knife", "flame"],
        "bbq": ["flame", "fork.knife"],
        "deli": ["fork.knife", "storefront"],
        "kitchen": ["fork.knife", "flame"],

        // --- Shopping ---
        "store": ["storefront", "cart", "bag"],
        "shop": ["storefront", "cart", "bag"],
        "mall": ["storefront", "cart", "building.2"],
        "market": ["cart", "storefront"],
        "grocery": ["cart", "storefront"],
        "supermarket": ["cart", "storefront"],
        "drugstore": ["cross.case", "storefront"],
        "boutique": ["storefront", "bag"],

        // --- Work & business ---
        "office": ["building.2", "desktopcomputer", "briefcase"],
        "work": ["briefcase", "building.2", "desktopcomputer"],
        "company": ["building.2", "briefcase"],
        "headquarters": ["building.2", "building.columns"],
        "hq": ["building.2", "building.columns"],
        "studio": ["paintbrush", "camera", "music.note"],
        "factory": ["building.2", "hammer"],
        "warehouse": ["building.2", "archivebox"],
        "startup": ["lightbulb", "desktopcomputer"],
        "coworking": ["desktopcomputer", "person.2"],
        "lab": ["flask", "testtube.2"],
        "bank": ["building.columns", "dollarsign.circle"],
        "finance": ["dollarsign.circle", "chart.bar"],

        // --- Education ---
        "school": ["graduationcap", "book", "building.columns"],
        "university": ["graduationcap", "building.columns", "book"],
        "college": ["graduationcap", "building.columns"],
        "campus": ["graduationcap", "building.columns", "tree"],
        "library": ["books.vertical", "book"],
        "classroom": ["graduationcap", "book"],
        "academy": ["graduationcap", "star"],
        "training": ["graduationcap", "figure.run"],
        "education": ["graduationcap", "book"],

        // --- Health & wellness ---
        "hospital": ["cross.case", "stethoscope", "building.2"],
        "clinic": ["cross.case", "stethoscope"],
        "doctor": ["stethoscope", "cross.case"],
        "medical": ["cross.case", "stethoscope"],
        "dentist": ["cross.case"],
        "pharmacy": ["cross.case", "storefront", "cart"],
        "health": ["heart", "cross.case"],
        "wellness": ["heart", "sparkles", "leaf"],
        "spa": ["sparkles", "drop", "leaf"],
        "salon": ["scissors", "sparkles"],
        "barber": ["scissors"],
        "therapy": ["heart", "brain"],

        // --- Fitness & sports ---
        "gym": ["dumbbell", "figure.run", "sportscourt"],
        "fitness": ["dumbbell", "figure.run"],
        "pool": ["figure.pool.swim", "drop"],
        "swimming": ["figure.pool.swim", "drop"],
        "tennis": ["figure.tennis", "sportscourt"],
        "basketball": ["sportscourt", "figure.run"],
        "soccer": ["sportscourt", "trophy"],
        "football": ["sportscourt", "trophy"],
        "baseball": ["sportscourt", "trophy"],
        "golf": ["flag", "tree", "sun.max"],
        "yoga": ["figure.mind.and.body", "leaf"],
        "pilates": ["figure.run", "heart"],
        "track": ["figure.run", "sportscourt"],
        "stadium": ["sportscourt", "trophy", "megaphone"],
        "arena": ["sportscourt", "trophy"],
        "sport": ["sportscourt", "dumbbell", "trophy"],
        "field": ["sportscourt", "leaf", "sun.max"],
        "court": ["sportscourt", "figure.tennis"],
        "rink": ["sportscourt", "snowflake"],
        "cycling": ["bicycle"],
        "bike": ["bicycle"],
        "running": ["figure.run"],
        "hiking": ["figure.hiking", "mountain.2"],
        "climbing": ["mountain.2", "figure.hiking"],
        "skiing": ["figure.skiing.downhill", "snowflake", "mountain.2"],
        "snowboard": ["figure.skiing.downhill", "snowflake"],

        // --- Travel & transit ---
        "airport": ["airplane", "globe"],
        "flight": ["airplane"],
        "airline": ["airplane"],
        "train": ["tram", "train.side.front.car"],
        "station": ["tram", "bus"],
        "bus": ["bus"],
        "subway": ["tram"],
        "metro": ["tram"],
        "ferry": ["ferry"],
        "boat": ["ferry", "sailboat"],
        "ship": ["ferry"],
        "cruise": ["ferry", "globe"],
        "port": ["ferry", "anchor"],
        "harbor": ["ferry", "anchor"],
        "marina": ["sailboat", "anchor"],
        "dock": ["ferry", "anchor"],
        "taxi": ["car"],
        "drive": ["car"],
        "road": ["car", "road.lanes"],
        "highway": ["car", "road.lanes"],
        "bridge": ["car"],
        "parking": ["car", "p.circle"],
        "garage": ["car"],
        "gas": ["car", "fuelpump"],

        // --- Nature & outdoors ---
        "park": ["tree", "leaf", "sun.max"],
        "garden": ["leaf", "flower", "sun.max"],
        "forest": ["tree", "leaf"],
        "woods": ["tree", "leaf"],
        "nature": ["leaf", "tree", "sun.max"],
        "beach": ["beach.umbrella", "sun.max", "drop"],
        "ocean": ["water.waves", "globe"],
        "sea": ["water.waves", "ferry"],
        "lake": ["water.waves", "drop"],
        "river": ["water.waves", "drop"],
        "waterfall": ["water.waves", "drop"],
        "mountain": ["mountain.2", "figure.hiking"],
        "hill": ["mountain.2", "tree"],
        "valley": ["mountain.2", "leaf"],
        "island": ["globe", "sun.max", "beach.umbrella"],
        "desert": ["sun.max", "flame"],
        "canyon": ["mountain.2"],
        "volcano": ["flame", "mountain.2"],
        "jungle": ["tree", "leaf"],
        "trail": ["figure.hiking", "tree", "leaf"],
        "farm": ["leaf", "sun.max", "pawprint"],
        "ranch": ["pawprint", "sun.max"],
        "zoo": ["pawprint", "tree"],
        "aquarium": ["fish", "drop"],
        "botanical": ["leaf", "flower"],
        "wildlife": ["pawprint", "tree"],
        "meadow": ["leaf", "sun.max", "flower"],

        // --- Entertainment & culture ---
        "theater": ["theatermasks", "film"],
        "theatre": ["theatermasks", "film"],
        "cinema": ["film", "theatermasks"],
        "movie": ["film"],
        "museum": ["building.columns", "photo.artframe"],
        "gallery": ["photo.artframe", "paintbrush"],
        "art": ["paintbrush", "photo.artframe"],
        "music": ["music.note", "guitars"],
        "concert": ["music.note", "megaphone"],
        "festival": ["music.note", "star", "sparkles"],
        "arcade": ["gamecontroller"],
        "game": ["gamecontroller", "puzzlepiece"],
        "bowling": ["sportscourt"],
        "casino": ["dollarsign.circle", "star"],
        "nightlife": ["moon.stars", "music.note", "sparkles"],
        "karaoke": ["music.note", "mic"],
        "comedy": ["theatermasks"],
        "opera": ["theatermasks", "music.note"],
        "dance": ["music.note", "figure.run"],
        "party": ["party.popper", "sparkles", "music.note"],
        "event": ["calendar", "star"],
        "amusement": ["star", "sparkles"],
        "carnival": ["star", "sparkles"],
        "theme": ["star", "sparkles"],

        // --- Religious & community ---
        "church": ["cross", "building.columns"],
        "temple": ["building.columns", "moon.stars"],
        "mosque": ["moon.stars", "building.columns"],
        "synagogue": ["star", "building.columns"],
        "chapel": ["cross", "building.columns"],
        "cathedral": ["cross", "building.columns"],
        "worship": ["cross", "moon.stars"],
        "prayer": ["cross", "moon.stars"],
        "community": ["person.3", "heart"],
        "center": ["building.2", "mappin"],
        "hall": ["building.columns"],
        "meetup": ["person.2", "bubble.left.and.bubble.right"],

        // --- Landmarks & named places ---
        "monument": ["building.columns", "star"],
        "memorial": ["building.columns", "star"],
        "landmark": ["building.columns", "mappin"],
        "tower": ["building.2"],
        "castle": ["building.columns", "flag"],
        "palace": ["building.columns", "crown"],
        "ruins": ["building.columns"],
        "plaza": ["mappin", "storefront"],
        "square": ["mappin", "building.columns"],

        // --- Major cities ---
        "nyc": ["building.2", "globe", "star"],
        "york": ["building.2", "globe"],
        "manhattan": ["building.2"],
        "brooklyn": ["building.2"],
        "paris": ["building.columns", "star", "globe"],
        "london": ["building.columns", "globe", "crown"],
        "tokyo": ["building.2", "globe", "star"],
        "berlin": ["building.columns", "globe"],
        "rome": ["building.columns", "globe"],
        "sydney": ["globe", "beach.umbrella"],
        "dubai": ["building.2", "sun.max", "star"],
        "miami": ["beach.umbrella", "sun.max", "palm"],
        "vegas": ["star", "sparkles", "dollarsign.circle"],
        "la": ["sun.max", "film", "car"],
        "angeles": ["sun.max", "film", "star"],
        "francisco": ["bridge", "globe", "building.2"],
        "sf": ["globe", "building.2"],
        "chicago": ["building.2", "wind"],
        "seattle": ["cloud", "building.2", "cup.and.saucer"],
        "boston": ["building.columns", "graduationcap"],
        "denver": ["mountain.2", "building.2"],
        "austin": ["music.note", "sun.max"],
        "nashville": ["music.note", "guitars"],
        "orlando": ["sun.max", "star", "sparkles"],
        "hawaii": ["beach.umbrella", "sun.max", "leaf"],
        "alaska": ["snowflake", "mountain.2", "tree"],
        "colorado": ["mountain.2", "snowflake", "tree"],
        "texas": ["star", "sun.max"],
        "california": ["sun.max", "beach.umbrella"],
        "florida": ["sun.max", "beach.umbrella"],

        // --- Groups & social activities ---
        "friends": ["person.2", "person.3", "heart"],
        "family": ["person.2", "house", "heart"],
        "team": ["person.3", "sportscourt", "trophy"],
        "crew": ["person.3", "star"],
        "squad": ["person.3", "star", "sparkles"],
        "group": ["folder", "person.2", "person.3"],
        "classmates": ["graduationcap", "person.3", "book"],
        "coworkers": ["briefcase", "building.2", "person.2"],
        "neighbors": ["house", "person.2", "mappin"],
        "roommates": ["house", "person.2", "bed.double"],
        "band": ["guitars", "music.note", "mic"],
        "choir": ["music.note", "person.3"],
        "book": ["book", "books.vertical"],
        "reading": ["book", "books.vertical", "cup.and.saucer"],
        "board": ["puzzlepiece", "gamecontroller", "person.2"],
        "poker": ["dollarsign.circle", "person.2", "star"],
        "trivia": ["brain", "person.3", "star"],
        "volunteer": ["heart", "hand.wave", "person.3"],
        "mentor": ["graduationcap", "lightbulb", "person.2"],
        "alumni": ["graduationcap", "building.columns", "person.3"],
        "fraternity": ["person.3", "star", "building.columns"],
        "sorority": ["person.3", "heart", "building.columns"],
        "wedding": ["heart", "sparkles", "gift"],
        "reunion": ["person.3", "star", "heart"],
        "crafts": ["paintbrush", "scissors", "sparkles"],
        "photography": ["camera", "photo.artframe"],
        "gaming": ["gamecontroller", "puzzlepiece"],
        "hobby": ["star", "paintbrush", "puzzlepiece"],
        "social": ["person.2", "bubble.left.and.bubble.right", "heart"],
        "networking": ["person.2", "briefcase", "globe"],
        "support": ["heart", "hand.wave", "person.2"],

        // --- General concepts ---
        "favorite": ["star", "heart"],
        "love": ["heart", "star"],
        "special": ["star", "sparkles"],
        "important": ["star", "flag"],
        "meet": ["person.2", "bubble.left.and.bubble.right"],
        "hangout": ["person.2", "cup.and.saucer"],
        "date": ["heart", "wineglass"],
        "vacation": ["airplane", "beach.umbrella", "sun.max"],
        "trip": ["airplane", "car", "globe"],
        "travel": ["airplane", "globe", "car"],
        "commute": ["car", "bus", "tram"],
        "walk": ["figure.walk", "shoe"],
        "run": ["figure.run"],
    ]
}
