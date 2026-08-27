normalize <- function(x) trimws(tolower(x))

label <- function(x) paste0("<", normalize(x), ">")

plural <- function(n) paste0(n, " items")

describe <- function(n) if(n > 1) plural(n) else "one item"
