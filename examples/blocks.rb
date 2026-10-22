# Blocks, iterators, lambdas
numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

evens = numbers.select { |n| n % 2 == 0 }
puts evens.inspect

doubled = numbers.map { |n| n * 2 }
puts doubled.inspect

sum = numbers.reduce(0) { |acc, n| acc + n }
puts "Sum: #{sum}"

# times
3.times { |i| puts "Iteration #{i}" }

# each_with_index
["a", "b", "c"].each_with_index do |item, idx|
  puts "#{idx}: #{item}"
end

# lambda
square = lambda { |x| x * x }
puts square.call(5)

cube = ->(x) { x * x * x }
puts cube.call(3)

# sort_by
words = ["banana", "apple", "cherry"]
puts words.sort_by { |w| w.length }.inspect
